// The orrery's secrets, writing them (ORR-1096): what `set`, `narrow`, `delete`, `egress` and `own` in
// web/server/utils/secrets.ts write to `secrets` and `secret_uses`. The value comes here already sealed: the key that
// seals and opens it stays with the local app (decision-rust-api-secrets-settings), which checks each write, seals it,
// tells the event log and sends what's kept here. So these routes are the local app's alone: the router sends none of
// them, and a browser can't reach them without the API's token.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{js, Effects};
use serde_json::{Map, Value};
use sqlx::AnyConnection;

const SEALED_FIELDS: [&str; 7] = ["value", "last4", "hosts", "projects", "created_by", "owned", "at"];
const USE_FIELDS: [&str; 10] = ["method", "host", "path", "project", "issue", "status", "error", "created_by", "created_at", "keep"];

/// Each problem with a body's fields, said as `checkInput` would.
struct Fields<'b> {
    sent: &'b Map<String, Value>,
    problems: Vec<String>,
}

impl<'b> Fields<'b> {
    fn new(body: &'b Value, takes: &[&str]) -> Result<Self> {
        let sent = body.as_object().ok_or_else(|| ApiError::bad_request("The body should be a JSON object"))?;
        let problems =
            sent.keys().filter(|key| !takes.contains(&key.as_str())).map(|key| format!("unknown field \"{key}\"; this takes {}", takes.join(", "))).collect();
        Ok(Fields { sent, problems })
    }

    fn text(&mut self, key: &str) -> String {
        match self.sent.get(key) {
            Some(Value::String(t)) if !t.is_empty() => t.clone(),
            Some(other) => {
                self.problems.push(format!("\"{key}\" should be a string, not {}", js(other)));
                String::new()
            }
            None => {
                self.problems.push(format!("missing \"{key}\""));
                String::new()
            }
        }
    }

    fn nullable(&mut self, key: &str) -> Option<String> {
        match self.sent.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::String(t)) => Some(t.clone()),
            Some(other) => {
                self.problems.push(format!("\"{key}\" should be a string or null, not {}", js(other)));
                None
            }
        }
    }

    /// A list of strings, kept as its JSON text; null when `nullable` and it's null.
    fn list(&mut self, key: &str, nullable: bool) -> Option<String> {
        match self.sent.get(key) {
            Some(Value::Array(items)) if items.iter().all(Value::is_string) => Some(Value::Array(items.clone()).to_string()),
            Some(Value::Null) | None if nullable => None,
            Some(other) => {
                self.problems.push(format!("\"{key}\" should be a list of strings, not {}", js(other)));
                None
            }
            None => {
                self.problems.push(format!("missing \"{key}\""));
                None
            }
        }
    }

    fn number(&mut self, key: &str) -> Option<i64> {
        match self.sent.get(key) {
            None | Some(Value::Null) => None,
            Some(n) if n.as_i64().is_some_and(|n| n >= 0) => n.as_i64(),
            Some(other) => {
                self.problems.push(format!("\"{key}\" should be a whole number or null, not {}", js(other)));
                None
            }
        }
    }

    fn done(self) -> Result<()> {
        if self.problems.is_empty() {
            Ok(())
        } else {
            Err(ApiError::problems(self.problems))
        }
    }
}

pub struct SecretWrites<'c> {
    conn: &'c mut AnyConnection,
    pub effects: Effects,
    pub outbox: Option<Outbox>,
}

impl<'c> SecretWrites<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        SecretWrites { conn, effects: Effects::default(), outbox: None }
    }

    /// Keeps the secret `name` as the local app sealed it (`set`, `narrow`): `{value, last4, hosts, projects,
    /// created_by, owned, at}`. A new one is made; one already kept takes the new value, hosts and projects, and keeps
    /// who made it and when.
    pub async fn keep(&mut self, name: &str, body: &Value) -> Result<()> {
        let mut fields = Fields::new(body, &SEALED_FIELDS)?;
        let value = fields.text("value");
        let last4 = fields.text("last4");
        let hosts = fields.list("hosts", false);
        let projects = fields.list("projects", true);
        let created_by = fields.text("created_by");
        let owned = match fields.sent.get("owned") {
            Some(Value::Bool(b)) => *b,
            other => {
                fields.problems.push(format!("\"owned\" should be true or false, not {}", other.map(js).unwrap_or_else(|| "missing".into())));
                false
            }
        };
        let at = fields.text("at");
        fields.done()?;
        changes::begin(self.conn).await?;
        let done = sqlx::query(&sql(
            "INSERT INTO secrets (name, value, last4, hosts, projects, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET value = excluded.value, last4 = excluded.last4, hosts = excluded.hosts, projects = excluded.projects, updated_at = excluded.updated_at",
        ))
        .bind(name)
        .bind(value)
        .bind(last4)
        .bind(hosts)
        .bind(projects)
        .bind(created_by)
        .bind(i64::from(owned))
        .bind(&at)
        .bind(&at)
        .execute(&mut *self.conn)
        .await
        .map(|_| ())
        .map_err(Into::into);
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Lets go of the secret `name` and its uses (`delete`); nothing when there's none.
    pub async fn forget(&mut self, name: &str) -> Result<()> {
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            for statement in ["DELETE FROM secrets WHERE name = ?", "DELETE FROM secret_uses WHERE secret = ?"] {
                sqlx::query(&sql(statement)).bind(name).execute(&mut *self.conn).await?;
            }
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Keeps a use of the secret `name` (`egress`, `own`): `{method, host, path, project, issue, status, error,
    /// created_by, created_at, keep?}`. With `keep`, only that many of the secret's uses by `created_by` stay, the
    /// latest, as orrery's own are kept (`OWN_USES`).
    pub async fn used(&mut self, name: &str, body: &Value) -> Result<()> {
        let mut fields = Fields::new(body, &USE_FIELDS)?;
        let method = fields.text("method");
        let host = fields.text("host");
        let path = fields.text("path");
        let project = fields.nullable("project");
        let issue = fields.nullable("issue");
        let status = fields.number("status");
        let error = fields.nullable("error");
        let created_by = fields.text("created_by");
        let created_at = fields.text("created_at");
        let keep = fields.number("keep");
        fields.done()?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql(
                "INSERT INTO secret_uses (secret, method, host, path, project, issue, status, error, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ))
            .bind(name)
            .bind(method)
            .bind(host)
            .bind(path)
            .bind(project)
            .bind(issue)
            .bind(status)
            .bind(error)
            .bind(&created_by)
            .bind(created_at)
            .execute(&mut *self.conn)
            .await?;
            if let Some(keep) = keep {
                sqlx::query(&sql(&format!(
                    "DELETE FROM secret_uses WHERE secret = ? AND created_by = ? AND id NOT IN
                     (SELECT id FROM (SELECT id FROM secret_uses WHERE secret = ? AND created_by = ? ORDER BY id DESC LIMIT {keep}) AS latest)"
                )))
                .bind(name)
                .bind(&created_by)
                .bind(name)
                .bind(&created_by)
                .execute(&mut *self.conn)
                .await?;
            }
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }
}
