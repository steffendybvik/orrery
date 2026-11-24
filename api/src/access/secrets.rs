// The orrery's secrets, reading them (ORR-953): what `list` and `get` in web/server/utils/secrets.ts do, on the same
// tables, answering as `GET /api/secrets` and `GET /api/secrets/{name}` do. Neither reads `value`: it's ciphertext, and
// the key that opens it stays with the local app (decision-rust-api-secrets-settings). So setting, narrowing and
// deleting one, and sending one out (egress), stay the Nuxt server's routes: it checks each, seals the value with the
// key and tells the event log, then keeps the row through work/secrets.rs (ORR-1096). The router sends only these reads here.
// The sealed rows, `value` and all, go only to the local app, which holds the key to open them (`sealed`, ORR-1143).
use crate::access::scope::Workspace;
use crate::db::sql;
use crate::error::{ApiError, Result};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::collections::HashSet;

type Query<'q> = sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments>;

/// How many uses a secret shows (`USES`).
const USES: i64 = 20;

const SECRET_COLUMNS: &str = "name, last4, hosts, projects, created_by, created_at, updated_at";
const SEALED_COLUMNS: &str = "name, value, last4, hosts, projects, created_by, CAST(owned AS BIGINT) AS owned, created_at, updated_at";
const USE_COLUMNS: &str =
    "CAST(id AS BIGINT) AS id, secret, method, host, path, project, issue, CAST(status AS BIGINT) AS status, error, created_by, created_at";

/// A JSON list kept as text, or null when there's none (`JSON.parse(row.projects)`).
fn parsed(text: Option<String>) -> Value {
    text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

/// A secret as it's handed out (`secretOf`): never its value, and none of the `hidden` projects it's narrowed to.
fn secret_of(row: &AnyRow, last: Value, hidden: &HashSet<String>) -> Map<String, Value> {
    let mut projects = parsed(row.get::<Option<String>, _>("projects"));
    if let Value::Array(list) = &mut projects {
        list.retain(|p| !p.as_str().is_some_and(|p| hidden.contains(p)));
    }
    let mut out = Map::new();
    out.insert("name".into(), json!(row.get::<String, _>("name")));
    out.insert("last4".into(), json!(row.get::<String, _>("last4")));
    out.insert("hosts".into(), parsed(Some(row.get::<String, _>("hosts"))));
    out.insert("projects".into(), projects);
    out.insert("created_by".into(), json!(row.get::<String, _>("created_by")));
    out.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
    out.insert("updated_at".into(), json!(row.get::<String, _>("updated_at")));
    out.insert("last_used".into(), last);
    out
}

/// A secret's row as kept (`SecretRow`), its lists still text, for the local app to open.
fn sealed_of(row: &AnyRow) -> Value {
    json!({
        "name": row.get::<String, _>("name"),
        "value": row.get::<String, _>("value"),
        "last4": row.get::<String, _>("last4"),
        "hosts": row.get::<String, _>("hosts"),
        "projects": row.get::<Option<String>, _>("projects"),
        "created_by": row.get::<String, _>("created_by"),
        "owned": row.get::<i64, _>("owned"),
        "created_at": row.get::<String, _>("created_at"),
        "updated_at": row.get::<String, _>("updated_at"),
    })
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
    /// The workspace whose secrets these are (ORR-1107): each has its own, by name.
    workspace: Workspace,
    /// The projects whose uses aren't shown: the boards a member isn't on (ORR-1388).
    hidden: HashSet<String>,
}

impl<'c> Secrets<'c> {
    /// The secrets of `workspace`.
    pub fn of(conn: &'c mut AnyConnection, workspace: Workspace) -> Self {
        Secrets { conn, workspace, hidden: HashSet::new() }
    }

    /// Leaves out the uses made for the `hidden` projects, and those projects among the ones a secret is narrowed to:
    /// a member doesn't learn of a board they aren't on through its secrets (ORR-1388).
    pub fn hiding(mut self, hidden: HashSet<String>) -> Self {
        self.hidden = hidden;
        self
    }

    /// The condition that keeps a use's project out of `hidden`, its placeholders bound by `bind_hidden`.
    fn shown_uses(&self) -> String {
        if self.hidden.is_empty() {
            return String::new();
        }
        format!(" AND (project IS NULL OR project NOT IN ({}))", vec!["?"; self.hidden.len()].join(", "))
    }

    fn bind_hidden<'q>(&self, mut query: Query<'q>) -> Query<'q> {
        for project in &self.hidden {
            query = query.bind(project.clone());
        }
        query
    }

    /// Every secret by name, each with its latest use (`list`).
    pub async fn list(&mut self) -> Result<Value> {
        let rows = sqlx::query(sql(&format!("SELECT {SECRET_COLUMNS} FROM secrets WHERE workspace = ? ORDER BY name")))
            .bind(self.workspace.id())
            .fetch_all(&mut *self.conn)
            .await?;
        let shown = self.shown_uses();
        let text =
            sql(&format!("SELECT {USE_COLUMNS} FROM secret_uses WHERE id IN (SELECT max(id) FROM secret_uses WHERE workspace = ?{shown} GROUP BY secret)"));
        let query = self.bind_hidden(sqlx::query(text.clone()).bind(self.workspace.id().to_string()));
        let last = query.fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(
            rows.iter()
                .map(|row| {
                    let name = row.get::<String, _>("name");
                    let used = last.iter().find(|u| u.get::<String, _>("secret") == name).map(use_of).unwrap_or(Value::Null);
                    Value::Object(secret_of(row, used, &self.hidden))
                })
                .collect(),
        ))
    }

    /// One secret with its latest uses, newest first (`get`).
    pub async fn secret(&mut self, name: &str) -> Result<Value> {
        let row = sqlx::query(sql(&format!("SELECT {SECRET_COLUMNS} FROM secrets WHERE name = ? AND workspace = ?")))
            .bind(name)
            .bind(self.workspace.id())
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No secret {name}")))?;
        let shown = self.shown_uses();
        let text = sql(&format!("SELECT {USE_COLUMNS} FROM secret_uses WHERE secret = ? AND workspace = ?{shown} ORDER BY id DESC LIMIT ?"));
        let query = self.bind_hidden(sqlx::query(text.clone()).bind(name.to_string()).bind(self.workspace.id().to_string())).bind(USES);
        let uses: Vec<Value> = query.fetch_all(&mut *self.conn).await?.iter().map(use_of).collect();
        let mut out = secret_of(&row, uses.first().cloned().unwrap_or(Value::Null), &self.hidden);
        out.insert("uses".into(), Value::Array(uses));
        Ok(Value::Object(out))
    }
    /// The secret as the local app sealed it, every column (`SecretRow`): its value is ciphertext only the local app's
    /// key opens. None when there's no such secret.
    pub async fn sealed(&mut self, name: &str) -> Result<Option<Value>> {
        let row = sqlx::query(sql(&format!("SELECT {SEALED_COLUMNS} FROM secrets WHERE name = ? AND workspace = ?")))
            .bind(name)
            .bind(self.workspace.id())
            .fetch_optional(&mut *self.conn)
            .await?;
        Ok(row.as_ref().map(sealed_of))
    }

    /// Every secret as sealed, by name (`sealed` for each), in every workspace: for the local app's scrubber, which
    /// takes any secret's value out of what it logs.
    pub async fn all_sealed(&mut self) -> Result<Value> {
        let rows = sqlx::query(sql(&format!("SELECT {SEALED_COLUMNS} FROM secrets ORDER BY name"))).fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(rows.iter().map(sealed_of).collect()))
    }
}
