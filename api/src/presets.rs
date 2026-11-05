// Presets (ORR-949): what web/server/store/presets.ts does with them, on the same table, answering as
// web/server/api/presets/ and `…/projects/{project}/presets` do. The presets orrery ships are read from the same
// web/shared/presets.json the Nuxt server imports, so a default's `changed` is worked out from one source. Seeding them
// as the server starts stays the Nuxt server's. Nothing they write wakes a session, so a write has no effects to tell.
use crate::db::sql;
use crate::docs::{js, stamp, Actor};
use crate::error::{ApiError, Result};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::sync::LazyLock;

/// A preset orrery ships (`DefaultPreset` in web/shared/presets.ts).
#[derive(Deserialize)]
struct Shipped {
    key: String,
    name: String,
    text: String,
    icon: String,
    color: String,
}

static SHIPPED: LazyLock<Vec<Shipped>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../web/shared/presets.json")).expect("web/shared/presets.json is the presets orrery ships"));

/// `PRESET_FIELDS` in web/server/store/schema.ts, in its order, which is the order its problems are found in.
const FIELDS: [&str; 4] = ["name", "text", "icon", "color"];
/// The named tints (`TINTS` in web/shared/roadmap/settings.ts), in their order.
const TINTS: [&str; 7] = ["slate", "blue", "teal", "green", "amber", "rose", "violet"];
static TINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^({}|#[0-9a-fA-F]{{6}})$", TINTS.join("|"))).unwrap());
static ICON: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-z0-9]+(-[a-z0-9]+)*$").unwrap());

const COLUMNS: &str = "CAST(id AS BIGINT) AS id, project, name, text, icon, color, default_key, created_at, updated_at";

/// The 403 for a session writing one, as `ownerOnly(actor, 'presets.write')` words it.
fn owner_only(actor: &Actor) -> Result<()> {
    if actor.owner {
        return Ok(());
    }
    Err(ApiError::refused_for(
        "presets.write",
        "Write presets: owner only for a session (presets.write). A preset’s text is an order every later session gets in the owner’s voice: one session writing it would write the orders for the rest. Send Orrery-Actor: <owner>",
    ))
}

/// A body as `checkInput(body, PRESET_FIELDS, partial)` takes it: `name` and `text` are required unless `partial`, and
/// can't be blank either way; `icon` and `color` can be null, which takes them off.
fn check_input(body: &Value, partial: bool) -> Result<Map<String, Value>> {
    let Some(sent) = body.as_object() else {
        return Err(ApiError::bad_request("The body should be a JSON object"));
    };
    let mut problems = vec![];
    for key in sent.keys() {
        if !FIELDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", FIELDS.join(", ")));
        }
    }
    let mut input = Map::new();
    for key in FIELDS {
        let required = key == "name" || key == "text";
        let Some(value) = sent.get(key) else {
            if required && !partial {
                problems.push(format!("missing \"{key}\""));
            }
            continue;
        };
        if value.is_null() {
            if required {
                problems.push(format!("\"{key}\" can't be null"));
            } else {
                input.insert(key.into(), Value::Null);
            }
            continue;
        }
        let Some(text) = value.as_str() else {
            problems.push(format!("\"{key}\" should be a string, not {}", js(value)));
            continue;
        };
        let problem = match key {
            "icon" if !ICON.is_match(text) => Some(format!("\"icon\" is \"{text}\"; use a Heroicon's name, e.g. shield-check")),
            "color" if !TINT.is_match(text) => Some(format!("\"color\" is \"{text}\"; use {} or a colour like #3b82f6", TINTS.join(", "))),
            _ if required && text.trim().is_empty() => Some(format!("\"{key}\" can't be empty")),
            _ => None,
        };
        match problem {
            Some(problem) => problems.push(problem),
            None => {
                input.insert(key.into(), value.clone());
            }
        }
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(input)
}

/// `name` or `text` as `presetInput` keeps it: trimmed, and refused if that leaves nothing.
fn trimmed(input: &Map<String, Value>, key: &str) -> Result<Option<String>> {
    match input.get(key).and_then(Value::as_str) {
        None => Ok(None),
        Some(value) if value.trim().is_empty() => Err(ApiError::bad_request(format!("\"{key}\" needs more than spaces"))),
        Some(value) => Ok(Some(value.trim().to_string())),
    }
}

/// A preset as the API gives it (`presetOf`): a default says which, and whether it's been changed since.
fn preset_of(row: &AnyRow) -> Value {
    let text = |column: &str| row.get::<Option<String>, _>(column);
    let mut out = Map::new();
    out.insert("id".into(), json!(row.get::<i64, _>("id")));
    out.insert("project".into(), json!(text("project")));
    out.insert("name".into(), json!(row.get::<String, _>("name")));
    out.insert("text".into(), json!(row.get::<String, _>("text")));
    out.insert("icon".into(), json!(text("icon")));
    out.insert("color".into(), json!(text("color")));
    out.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
    out.insert("updated_at".into(), json!(row.get::<String, _>("updated_at")));
    if let Some(shipped) = text("default_key").and_then(|key| SHIPPED.iter().find(|d| d.key == key)) {
        // `asShipped`: its name, text and badge as orrery ships them.
        let as_shipped = out["name"] == json!(shipped.name)
            && out["text"] == json!(shipped.text)
            && out["icon"] == json!(shipped.icon)
            && out["color"] == json!(shipped.color);
        out.insert("default".into(), json!({"key": shipped.key, "changed": !as_shipped}));
    }
    Value::Object(out)
}

/// A preset's number from the URL, or from its full form on this server (`serverId`, ORR-674): `pst-12-x7k2m9qd`.
pub fn preset_id(sent: &str, uid: &str) -> Result<i64> {
    server_id("pst-", "preset", sent, uid)
}

/// A preset's or schedule's number from the URL, or from its full form on this server (`serverId`): `prefix`, the
/// number, then `-` and the server's uid.
pub fn server_id(prefix: &str, kind: &str, sent: &str, uid: &str) -> Result<i64> {
    let tail = format!("-{uid}");
    let short = (!uid.is_empty() && sent.starts_with(prefix) && sent.ends_with(&tail) && sent.len() > prefix.len() + tail.len())
        .then(|| &sent[prefix.len()..sent.len() - tail.len()]);
    let id = short.unwrap_or(sent).trim();
    match id.parse::<f64>() {
        Ok(n) if !id.is_empty() && n.is_finite() && n.fract() == 0.0 && n.abs() < 9e15 => Ok(n as i64),
        _ => Err(ApiError::not_found(format!("No {kind} {sent}"))),
    }
}

pub struct Presets<'c> {
    pub conn: &'c mut AnyConnection,
}

impl<'c> Presets<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Presets { conn }
    }

    /// The server's own random id, which a preset's full id ends with.
    pub async fn uid(&mut self) -> Result<String> {
        let row = sqlx::query("SELECT value FROM settings WHERE key = 'uid'").fetch_optional(&mut *self.conn).await?;
        Ok(row.and_then(|r| serde_json::from_str::<String>(&r.get::<String, _>("value")).ok()).unwrap_or_default())
    }

    async fn project_there(&mut self, project: &str) -> Result<()> {
        match sqlx::query(&sql("SELECT 1 FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await? {
            Some(_) => Ok(()),
            None => Err(ApiError::not_found(format!("No project \"{project}\""))),
        }
    }

    async fn row(&mut self, id: i64) -> Result<AnyRow> {
        let query = format!("SELECT {COLUMNS} FROM presets WHERE id = ?");
        sqlx::query(&sql(&query)).bind(id).fetch_optional(&mut *self.conn).await?.ok_or_else(|| ApiError::not_found(format!("No preset {id}")))
    }

    pub async fn preset(&mut self, id: i64) -> Result<Value> {
        Ok(preset_of(&self.row(id).await?))
    }

    /// The orrery's presets, by name; with a project, those a session on it can have: the orrery's, then its own.
    pub async fn list(&mut self, project: Option<&str>) -> Result<Value> {
        if let Some(project) = project {
            self.project_there(project).await?;
        }
        let query = format!("SELECT {COLUMNS} FROM presets WHERE project IS NULL OR project = ? ORDER BY project IS NOT NULL, lower(name), id");
        let rows = sqlx::query(&sql(&query)).bind(project).fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(rows.iter().map(preset_of).collect()))
    }

    /// A new preset, the orrery's, or with `project` that project's own.
    pub async fn create(&mut self, project: Option<&str>, body: &Value, actor: &Actor) -> Result<Value> {
        owner_only(actor)?;
        if let Some(project) = project {
            self.project_there(project).await?;
        }
        let input = check_input(body, false)?;
        let (name, text) = (trimmed(&input, "name")?, trimmed(&input, "text")?);
        let now = stamp();
        let row = sqlx::query(&sql(
            "INSERT INTO presets (project, name, text, icon, color, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS BIGINT) AS id",
        ))
        .bind(project)
        .bind(name)
        .bind(text)
        .bind(input.get("icon").and_then(Value::as_str))
        .bind(input.get("color").and_then(Value::as_str))
        .bind(&actor.name)
        .bind(i64::from(actor.owner))
        .bind(&now)
        .bind(&now)
        .fetch_one(&mut *self.conn)
        .await?;
        self.preset(row.get("id")).await
    }

    /// Renames a preset, or changes its text or badge (null takes the icon or colour off); whose it is stays.
    pub async fn update(&mut self, id: i64, body: &Value, actor: &Actor) -> Result<Value> {
        owner_only(actor)?;
        self.row(id).await?;
        let input = check_input(body, true)?;
        let mut set: Vec<(&str, Option<String>)> = vec![];
        for key in ["name", "text"] {
            if let Some(value) = trimmed(&input, key)? {
                set.push((key, Some(value)));
            }
        }
        for key in ["icon", "color"] {
            if let Some(value) = input.get(key) {
                set.push((key, value.as_str().map(str::to_string)));
            }
        }
        self.set(id, set).await?;
        self.preset(id).await
    }

    /// Sets the given columns and the update time (`update` in web/server/store/base.ts).
    async fn set(&mut self, id: i64, set: Vec<(&str, Option<String>)>) -> Result<()> {
        let columns: Vec<String> = set.iter().map(|(column, _)| format!("{column} = ?")).chain(["updated_at = ?".to_string()]).collect();
        let query = sql(&format!("UPDATE presets SET {} WHERE id = ?", columns.join(", ")));
        let mut update = sqlx::query(&query);
        for (_, value) in set {
            update = update.bind(value);
        }
        update.bind(stamp()).bind(id).execute(&mut *self.conn).await?;
        Ok(())
    }

    pub async fn delete(&mut self, id: i64, actor: &Actor) -> Result<()> {
        owner_only(actor)?;
        self.row(id).await?;
        sqlx::query(&sql("DELETE FROM presets WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// Puts a default preset back as orrery ships it: its name, text and badge.
    pub async fn reset(&mut self, id: i64, actor: &Actor) -> Result<Value> {
        owner_only(actor)?;
        let row = self.row(id).await?;
        let key = row.get::<Option<String>, _>("default_key");
        let Some(shipped) = key.and_then(|key| SHIPPED.iter().find(|d| d.key == key)) else {
            let name = row.get::<String, _>("name");
            return Err(ApiError::conflict(format!("Resetting preset {id}: {name} isn't one orrery ships, so it has no default")));
        };
        let set = vec![
            ("name", Some(shipped.name.clone())),
            ("text", Some(shipped.text.clone())),
            ("icon", Some(shipped.icon.clone())),
            ("color", Some(shipped.color.clone())),
        ];
        self.set(id, set).await?;
        self.preset(id).await
    }

    /// Adds back the presets orrery ships that were removed, as it ships them; says which.
    pub async fn restore(&mut self, actor: &Actor) -> Result<Value> {
        owner_only(actor)?;
        let rows = sqlx::query("SELECT default_key FROM presets WHERE default_key IS NOT NULL").fetch_all(&mut *self.conn).await?;
        let kept: Vec<String> = rows.iter().map(|r| r.get("default_key")).collect();
        let mut restored = vec![];
        for shipped in SHIPPED.iter().filter(|d| !kept.contains(&d.key)) {
            let now = stamp();
            let row = sqlx::query(&sql("INSERT INTO presets (project, name, text, icon, color, default_key, created_by, owned, created_at, updated_at) \
                 VALUES (NULL, ?, ?, ?, ?, ?, 'orrery', 1, ?, ?) RETURNING CAST(id AS BIGINT) AS id"))
            .bind(&shipped.name)
            .bind(&shipped.text)
            .bind(&shipped.icon)
            .bind(&shipped.color)
            .bind(&shipped.key)
            .bind(&now)
            .bind(&now)
            .fetch_one(&mut *self.conn)
            .await?;
            restored.push(self.preset(row.get("id")).await?);
        }
        Ok(Value::Array(restored))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(preset_id("12", "x7k2m9qd").unwrap(), 12);
        assert_eq!(preset_id("pst-12-x7k2m9qd", "x7k2m9qd").unwrap(), 12);
        assert!(preset_id("pst-12-aaaaaaaa", "x7k2m9qd").is_err());
        assert!(preset_id("abc", "x7k2m9qd").is_err() && preset_id("1.5", "").is_err());
    }

    #[test]
    fn shipped() {
        assert!(SHIPPED.iter().any(|d| d.key == "release"), "the presets orrery ships are read");
    }

    #[test]
    fn input() {
        assert!(check_input(&json!({"name": "A", "text": "B", "icon": null, "color": "rose"}), false).is_ok());
        let refused = |body: Value, partial: bool| check_input(&body, partial).err().map(|e| e.message).unwrap_or_default();
        assert_eq!(refused(json!({"name": "A"}), false), "missing \"text\"");
        assert_eq!(refused(json!({"name": " "}), true), "\"name\" can't be empty");
        assert_eq!(refused(json!({"icon": "Bad Icon"}), true), "\"icon\" is \"Bad Icon\"; use a Heroicon's name, e.g. shield-check");
        assert_eq!(refused(json!({"text": null, "x": 1}), true), "2 problems in the body");
    }
}
