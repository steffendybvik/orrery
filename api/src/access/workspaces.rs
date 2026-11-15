// The workspaces themselves (ORR-1108, decision-workspaces step 5): the ones a person is in, making one, and its
// owners renaming or recolouring it. What's in a workspace is held by `Seen`; this is the page's way to show and switch it.
use crate::access::seen::Seen;
use crate::board::statuses::{TINT, TINTS};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::text::slugify;
use crate::write::stamp;
use serde_json::{json, Map, Value};
use sqlx::{AnyConnection, Row};

pub(crate) struct Workspaces<'c> {
    conn: &'c mut AnyConnection,
}

impl<'c> Workspaces<'c> {
    pub(crate) fn new(conn: &'c mut AnyConnection) -> Self {
        Workspaces { conn }
    }

    /// The workspaces `seen` reaches, `default` first then by name: {id, name, color, role}, `role` the person's there
    /// (`owner` or `member`), or null where they reach it without being a member (the Nuxt server's own work).
    pub(crate) async fn list(&mut self, seen: &Seen, person: Option<&str>) -> Result<Value> {
        let rows =
            sqlx::query(&sql("SELECT w.id, w.name, w.color, m.role FROM workspaces w LEFT JOIN workspace_members m ON m.workspace = w.id AND m.person = ?
             ORDER BY CASE WHEN w.id = 'default' THEN 0 ELSE 1 END, lower(w.name), w.id"))
            .bind(person.unwrap_or_default())
            .fetch_all(&mut *self.conn)
            .await?;
        let reached = |id: &str| match seen {
            Seen::All => true,
            Seen::Only { workspaces, .. } => workspaces.iter().any(|w| w == id),
        };
        Ok(Value::Array(rows.iter().filter(|r| reached(&r.get::<String, _>("id"))).map(row).collect()))
    }

    /// One workspace, as `list` gives it, for `person`.
    async fn one(&mut self, id: &str, person: &str) -> Result<Value> {
        let r = sqlx::query(&sql(
            "SELECT w.id, w.name, w.color, m.role FROM workspaces w LEFT JOIN workspace_members m ON m.workspace = w.id AND m.person = ? WHERE w.id = ?",
        ))
        .bind(person)
        .bind(id)
        .fetch_optional(&mut *self.conn)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("No workspace {id}")))?;
        Ok(row(&r))
    }

    /// Makes a workspace {name, color?} with `person` its owner (decision-workspaces: anyone can make one, and owns it).
    /// Its id comes from the name, with `-2`, `-3`… when that's taken.
    pub(crate) async fn create(&mut self, body: &Value, person: Option<&str>) -> Result<Value> {
        let person = person.ok_or_else(|| ApiError::forbidden("Only a person makes a workspace: sign in first"))?;
        let name = name_of(body)?.ok_or_else(|| ApiError::bad_request("A workspace needs a name"))?;
        let color = color_of(body)?.flatten();
        let base = match slugify(&name) {
            slug if slug.is_empty() => "workspace".to_string(),
            slug => slug,
        };
        let mut id = base.clone();
        let mut n = 1;
        while sqlx::query(&sql("SELECT 1 FROM workspaces WHERE id = ?")).bind(&id).fetch_optional(&mut *self.conn).await?.is_some() {
            n += 1;
            id = format!("{base}-{n}");
        }
        let at = stamp();
        sqlx::query(&sql("INSERT INTO workspaces (id, name, color, created_at) VALUES (?, ?, ?, ?)"))
            .bind(&id)
            .bind(&name)
            .bind(color.as_deref())
            .bind(&at)
            .execute(&mut *self.conn)
            .await?;
        sqlx::query(&sql("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES (?, ?, 'owner', ?)"))
            .bind(&id)
            .bind(person)
            .bind(&at)
            .execute(&mut *self.conn)
            .await?;
        self.one(&id, person).await
    }

    /// Changes a workspace's {name?, color?}: its owners' to do. One `person` isn't in is a 404, as if it weren't here.
    pub(crate) async fn update(&mut self, id: &str, body: &Value, person: Option<&str>) -> Result<Value> {
        let missing = || ApiError::not_found(format!("No workspace {id}"));
        let person = person.ok_or_else(missing)?;
        let role = sqlx::query(&sql("SELECT role FROM workspace_members WHERE workspace = ? AND person = ?"))
            .bind(id)
            .bind(person)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(missing)?
            .get::<String, _>("role");
        if role != "owner" {
            return Err(ApiError::forbidden("Only the workspace's owners change its name or colour"));
        }
        if let Some(name) = name_of(body)? {
            sqlx::query(&sql("UPDATE workspaces SET name = ? WHERE id = ?")).bind(&name).bind(id).execute(&mut *self.conn).await?;
        }
        if let Some(color) = color_of(body)? {
            sqlx::query(&sql("UPDATE workspaces SET color = ? WHERE id = ?")).bind(color.as_deref()).bind(id).execute(&mut *self.conn).await?;
        }
        self.one(id, person).await
    }
}

fn row(r: &sqlx::any::AnyRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"),
        "name": r.get::<String, _>("name"),
        "color": r.get::<Option<String>, _>("color"),
        "role": r.get::<Option<String>, _>("role"),
    })
}

/// The body's `name`, trimmed: none when it isn't sent, a 400 when it's empty, not text, or longer than 60.
fn name_of(body: &Value) -> Result<Option<String>> {
    let Some(name) = body.get("name") else { return Ok(None) };
    let name = name.as_str().map(str::trim).unwrap_or_default();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(ApiError::bad_request("A workspace's name is 1 to 60 characters"));
    }
    Ok(Some(name.to_string()))
}

/// The body's `color`: none when it isn't sent, `Some(None)` when it's null (no colour), else one of the tints or a
/// `#rrggbb`, as App settings' tint takes.
fn color_of(body: &Value) -> Result<Option<Option<String>>> {
    let Some(color) = body.as_object().and_then(|o: &Map<String, Value>| o.get("color")) else { return Ok(None) };
    match color {
        Value::Null => Ok(Some(None)),
        Value::String(c) if TINT.is_match(c) => Ok(Some(Some(c.clone()))),
        _ => Err(ApiError::bad_request(format!("A workspace's colour is one of {}, or one like #3b82f6", TINTS.join(", ")))),
    }
}
