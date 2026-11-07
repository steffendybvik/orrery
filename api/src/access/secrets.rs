// The orrery's secrets, reading them (ORR-953): what `list` and `get` in web/server/utils/secrets.ts do, on the same
// tables, answering as `GET /api/secrets` and `GET /api/secrets/{name}` do. Neither reads `value`: it's ciphertext, and
// the key that opens it stays with the local app (decision-rust-api-secrets-settings). So setting, narrowing and
// deleting one, and sending one out (egress), stay the Nuxt server's: setting and narrowing seal the value with the key,
// and each write is told to the event log. The router sends only these reads here.
use crate::db::sql;
use crate::error::{ApiError, Result};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

/// How many uses a secret shows (`USES`).
const USES: i64 = 20;

const SECRET_COLUMNS: &str = "name, last4, hosts, projects, created_by, created_at, updated_at";
const USE_COLUMNS: &str =
    "CAST(id AS BIGINT) AS id, secret, method, host, path, project, issue, CAST(status AS BIGINT) AS status, error, created_by, created_at";

/// A JSON list kept as text, or null when there's none (`JSON.parse(row.projects)`).
fn parsed(text: Option<String>) -> Value {
    text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

/// A secret as it's handed out (`secretOf`): never its value.
fn secret_of(row: &AnyRow, last: Value) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("name".into(), json!(row.get::<String, _>("name")));
    out.insert("last4".into(), json!(row.get::<String, _>("last4")));
    out.insert("hosts".into(), parsed(Some(row.get::<String, _>("hosts"))));
    out.insert("projects".into(), parsed(row.get::<Option<String>, _>("projects")));
    out.insert("created_by".into(), json!(row.get::<String, _>("created_by")));
    out.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
    out.insert("updated_at".into(), json!(row.get::<String, _>("updated_at")));
    out.insert("last_used".into(), last);
    out
}

/// A use of a secret as it's handed out (`useOf`).
fn use_of(row: &AnyRow) -> Value {
    json!({
        "id": row.get::<i64, _>("id"),
        "secret": row.get::<String, _>("secret"),
        "method": row.get::<String, _>("method"),
        "host": row.get::<String, _>("host"),
        "path": row.get::<String, _>("path"),
        "project": row.get::<Option<String>, _>("project"),
        "issue": row.get::<Option<String>, _>("issue"),
        "status": row.get::<Option<i64>, _>("status"),
        "error": row.get::<Option<String>, _>("error"),
        "created_by": row.get::<String, _>("created_by"),
        "created_at": row.get::<String, _>("created_at"),
    })
}

pub struct Secrets<'c> {
    conn: &'c mut AnyConnection,
}

impl<'c> Secrets<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Secrets { conn }
    }

    /// Every secret by name, each with its latest use (`list`).
    pub async fn list(&mut self) -> Result<Value> {
        let rows = sqlx::query(&sql(&format!("SELECT {SECRET_COLUMNS} FROM secrets ORDER BY name"))).fetch_all(&mut *self.conn).await?;
        let last = sqlx::query(&sql(&format!("SELECT {USE_COLUMNS} FROM secret_uses WHERE id IN (SELECT max(id) FROM secret_uses GROUP BY secret)")))
            .fetch_all(&mut *self.conn)
            .await?;
        Ok(Value::Array(
            rows.iter()
                .map(|row| {
                    let name = row.get::<String, _>("name");
                    let used = last.iter().find(|u| u.get::<String, _>("secret") == name).map(use_of).unwrap_or(Value::Null);
                    Value::Object(secret_of(row, used))
                })
                .collect(),
        ))
    }

    /// One secret with its latest uses, newest first (`get`).
    pub async fn secret(&mut self, name: &str) -> Result<Value> {
        let row = sqlx::query(&sql(&format!("SELECT {SECRET_COLUMNS} FROM secrets WHERE name = ?")))
            .bind(name)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No secret {name}")))?;
        let uses: Vec<Value> = sqlx::query(&sql(&format!("SELECT {USE_COLUMNS} FROM secret_uses WHERE secret = ? ORDER BY id DESC LIMIT ?")))
            .bind(name)
            .bind(USES)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(use_of)
            .collect();
        let mut out = secret_of(&row, uses.first().cloned().unwrap_or(Value::Null));
        out.insert("uses".into(), Value::Array(uses));
        Ok(Value::Object(out))
    }
}
