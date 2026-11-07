// The orrery's issue statuses (ORR-926): what web/server/store/statuses.ts does with them, on the same table, answering
// as web/server/api/statuses/ does. Every board has them, so a change tells every project and the settings stream
// (`Effects.settings`), which the router in front fires as the store's `statusesChanged` would.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::text::{is_slug, slugify};
use crate::write::{js, Actor, Effects};
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::{AnyConnection, Row};
use std::sync::LazyLock;

/// What a status means, in board order (`KINDS` in web/shared/roadmap/board.ts).
const KINDS: [&str; 5] = ["backlog", "todo", "started", "done", "canceled"];
/// `STATUS_FIELDS` in web/server/store/schema.ts, in its order, which is the order its problems are found in.
const FIELDS: [&str; 5] = ["id", "name", "kind", "color", "position"];
/// The named tints (`TINTS` in web/shared/roadmap/settings.ts), in their order.
pub const TINTS: [&str; 7] = ["slate", "blue", "teal", "green", "amber", "rose", "violet"];
pub static TINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^({}|#[0-9a-fA-F]{{6}})$", TINTS.join("|"))).unwrap());

/// The 403 for a session changing them, as `ownerOnly(actor, 'settings.write')` words it.
fn owner_only(actor: &Actor) -> Result<()> {
    if actor.owner {
        return Ok(());
    }
    Err(ApiError::refused_for(
        "settings.write",
        "Change App settings and the statuses: owner only for a session (settings.write). They change how orrery runs for every project and session. Send Orrery-Actor: <owner>",
    ))
}

/// A body as `checkInput(body, STATUS_FIELDS, partial)` takes it: `name` and `kind` are required unless `partial`.
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
        let Some(value) = sent.get(key) else {
            if !partial && (key == "name" || key == "kind") {
                problems.push(format!("missing \"{key}\""));
            }
            continue;
        };
        if value.is_null() {
            problems.push(format!("\"{key}\" can't be null"));
            continue;
        }
        if key == "position" {
            if value.is_number() {
                input.insert(key.into(), value.clone());
            } else {
                problems.push(format!("\"{key}\" should be a number, not {}", js(value)));
            }
            continue;
        }
        let Some(text) = value.as_str() else {
            problems.push(format!("\"{key}\" should be a string, not {}", js(value)));
            continue;
        };
        let problem = match key {
            "kind" if !KINDS.contains(&text) => Some(format!("\"kind\" is \"{text}\", not one of {}", KINDS.join(", "))),
            "id" if !is_slug(text) => Some(format!("\"id\" is \"{text}\"; use lowercase letters, digits and dashes")),
            "color" if !TINT.is_match(text) => Some(format!("\"color\" is \"{text}\"; use {} or a colour like #3b82f6", TINTS.join(", "))),
            "name" if text.trim().is_empty() => Some("\"name\" can't be empty".into()),
            "kind" if text.trim().is_empty() => Some("\"kind\" can't be empty".into()),
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

#[derive(Clone, Debug)]
struct Status {
    id: String,
    name: String,
    kind: String,
    color: String,
    position: f64,
}

impl Status {
    fn json(&self) -> Value {
        json!({"id": self.id, "name": self.name, "kind": self.kind, "color": self.color, "position": self.position})
    }
}

pub struct Statuses<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Statuses<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Statuses { conn, effects: Effects::default(), outbox: None }
    }

    /// In board order: by kind, then as arranged.
    async fn rows(&mut self) -> Result<Vec<Status>> {
        let rows = sqlx::query("SELECT id, name, kind, color, CAST(position AS DOUBLE PRECISION) AS position FROM statuses ORDER BY position, id")
            .fetch_all(&mut *self.conn)
            .await?;
        let all: Vec<Status> = rows
            .iter()
            .map(|r| Status { id: r.get("id"), name: r.get("name"), kind: r.get("kind"), color: r.get("color"), position: r.get("position") })
            .collect();
        Ok(KINDS.iter().flat_map(|kind| all.iter().filter(|s| s.kind == *kind).cloned()).collect())
    }

    async fn status(&mut self, id: &str) -> Result<Status> {
        self.rows().await?.into_iter().find(|s| s.id == id).ok_or_else(|| ApiError::not_found(format!("No status \"{id}\"")))
    }

    async fn keep_one_of(&mut self, status: &Status) -> Result<()> {
        if self.rows().await?.iter().filter(|s| s.kind == status.kind).count() == 1 {
            return Err(ApiError::conflict(format!("{} is the only {} status; add another before it goes", status.name, status.kind)));
        }
        Ok(())
    }

    /// Every board is drawn again with them, and the page gets the new list with the settings.
    async fn changed(&mut self) -> Result<()> {
        let rows = sqlx::query("SELECT id FROM projects").fetch_all(&mut *self.conn).await?;
        self.effects.changed = rows.iter().map(|r| r.get::<String, _>("id")).collect();
        self.effects.settings = true;
        Ok(())
    }

    pub async fn list(&mut self) -> Result<Value> {
        Ok(Value::Array(self.rows().await?.iter().map(Status::json).collect()))
    }

    pub async fn create(&mut self, body: &Value, actor: &Actor) -> Result<Value> {
        owner_only(actor)?;
        let input = check_input(body, false)?;
        let name = input["name"].as_str().unwrap_or_default().trim().to_string();
        let id = match input.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(id) => id.to_string(),
            None => slugify(&name),
        };
        if !is_slug(&id) {
            return Err(ApiError::bad_request(format!("\"{name}\" doesn't make an id; give one in \"id\"")));
        }
        if id == "proposed" {
            return Err(ApiError::bad_request("\"proposed\" is where proposals sit; give the status another id"));
        }
        if sqlx::query(&sql("SELECT 1 FROM statuses WHERE id = ?")).bind(&id).fetch_optional(&mut *self.conn).await?.is_some() {
            return Err(ApiError::conflict(format!("There is already a status \"{id}\"")));
        }
        let position = match input.get("position").and_then(Value::as_f64) {
            Some(position) => position,
            None => {
                let row = sqlx::query("SELECT CAST(max(position) AS DOUBLE PRECISION) AS n FROM statuses").fetch_one(&mut *self.conn).await?;
                row.get::<Option<f64>, _>("n").unwrap_or(0.0) + 1.0
            }
        };
        let color = input.get("color").and_then(Value::as_str).unwrap_or("slate");
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql("INSERT INTO statuses (id, name, kind, color, position) VALUES (?, ?, ?, ?, ?)"))
                .bind(&id)
                .bind(&name)
                .bind(input["kind"].as_str().unwrap_or_default())
                .bind(color)
                .bind(position)
                .execute(&mut *self.conn)
                .await?;
            self.changed().await
        }
        .await;
        self.finish(done).await?;
        Ok(self.status(&id).await?.json())
    }

    pub async fn update(&mut self, id: &str, body: &Value, actor: &Actor) -> Result<Value> {
        owner_only(actor)?;
        let before = self.status(id).await?;
        let input = check_input(body, true)?;
        if input.get("id").and_then(Value::as_str).is_some_and(|sent| sent != id) {
            return Err(ApiError::bad_request("A status's id can't change; rename it with \"name\""));
        }
        let kind = input.get("kind").and_then(Value::as_str);
        if kind.is_some_and(|k| k != before.kind) {
            self.keep_one_of(&before).await?;
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql("UPDATE statuses SET name = coalesce(?, name), kind = coalesce(?, kind), color = coalesce(?, color), position = ? WHERE id = ?"))
                .bind(input.get("name").and_then(Value::as_str).map(|n| n.trim().to_string()))
                .bind(kind.map(str::to_string))
                .bind(input.get("color").and_then(Value::as_str).map(str::to_string))
                // Its position as it was when none is sent, never a null: sqlx 0.8's Any driver binds a null f64 as a float4,
                // and Postgres keeps that type for the statement, so a later real position on the same connection fails (ORR-1057).
                .bind(input.get("position").and_then(Value::as_f64).unwrap_or(before.position))
                .bind(id)
                .execute(&mut *self.conn)
                .await?;
            self.changed().await
        }
        .await;
        self.finish(done).await?;
        Ok(self.status(id).await?.json())
    }

    /// Its issues and schedules move to `into`, which it needs while it has any; the last of a kind stays.
    pub async fn delete(&mut self, id: &str, into: Option<&str>, actor: &Actor) -> Result<()> {
        owner_only(actor)?;
        let status = self.status(id).await?;
        self.keep_one_of(&status).await?;
        let like = format!("%\"{id}\"%");
        let row = sqlx::query(&sql(
            "SELECT CAST((SELECT count(*) FROM issues WHERE status = ?) + (SELECT count(*) FROM schedules WHERE place = ? OR move_from LIKE ?) AS BIGINT) AS n",
        ))
        .bind(id)
        .bind(id)
        .bind(&like)
        .fetch_one(&mut *self.conn)
        .await?;
        let used: i64 = row.get("n");
        if let Some(into) = into {
            self.status(into).await?;
        }
        if into == Some(id) {
            return Err(ApiError::bad_request("Move its issues to another status"));
        }
        if used > 0 && into.is_none() {
            return Err(ApiError::conflict(format!("{used} issues or schedules are in {}; say which status they move to with ?into=", status.name)));
        }
        changes::begin(self.conn).await?;
        let done = match self.move_and_delete(id, into, &like).await {
            Ok(()) => self.changed().await,
            failed => failed,
        };
        self.finish(done).await
    }

    /// Ends the transaction `changes::begin` started: kept, with its outbox rows, when its work went through.
    async fn finish<T>(&mut self, done: Result<T>) -> Result<T> {
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn move_and_delete(&mut self, id: &str, into: Option<&str>, like: &str) -> Result<()> {
        if let Some(into) = into {
            for query in [
                "UPDATE issues SET status = ? WHERE status = ?",
                "UPDATE schedules SET place = ? WHERE place = ?",
                "UPDATE signals SET status = ? WHERE status = ?",
            ] {
                sqlx::query(&sql(query)).bind(into).bind(id).execute(&mut *self.conn).await?;
            }
            sqlx::query(&sql("UPDATE schedules SET move_from = replace(move_from, ?, ?) WHERE move_from LIKE ?"))
                .bind(format!("\"{id}\""))
                .bind(format!("\"{into}\""))
                .bind(like)
                .execute(&mut *self.conn)
                .await?;
        }
        sqlx::query(&sql("DELETE FROM statuses WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
        Ok(())
    }
}
