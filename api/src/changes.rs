// The outbox (ORR-929, the `rust-api-events` decision): a row for each thing a write set off, so the local app can
// follow a board it doesn't front, from `GET /api/changes?after=<id>`, and carry on from where it was after a gap. The
// rows go in inside each write's own transaction (`finish`), so a rolled-back write says nothing and a committed one is
// never lost. The Nuxt server's own writes add theirs next. Nothing reads them yet: the reply headers still carry what
// changed.
use crate::db::sql;
use crate::docs::{stamp, Actor, Effects};
use crate::error::{ApiError, Result};
use serde_json::{json, Value};
use sqlx::{AnyConnection, Row};

/// How many rows one read gives at most.
const PAGE: i64 = 500;

/// A write request's way into the outbox: who's writing, and what its transactions have recorded so far. A request can
/// run more than one (renaming a section, then moving it), and each records only what the ones before it didn't.
pub struct Outbox {
    actor: Actor,
    changed: Vec<String>,
    settings: bool,
    told: usize,
}

impl Outbox {
    pub fn new(actor: Actor) -> Self {
        Outbox { actor, changed: vec![], settings: false, told: 0 }
    }

    /// Records what `effects` holds that this request hasn't recorded yet, on `conn`, inside its transaction.
    async fn send(&mut self, conn: &mut AnyConnection, effects: &Effects) -> Result<()> {
        let changed: Vec<&String> = effects.changed.iter().filter(|p| !self.changed.contains(p)).collect();
        let settings = effects.settings && !self.settings;
        let told = &effects.told[self.told.min(effects.told.len())..];
        record(conn, &changed, settings, told, &self.actor).await?;
        self.changed.extend(changed.into_iter().cloned());
        self.settings |= settings;
        self.told = effects.told.len();
        Ok(())
    }
}

/// Starts a write's transaction.
pub async fn begin(conn: &mut AnyConnection) -> Result<()> {
    sqlx::query(if crate::db::on_postgres() { "BEGIN" } else { "BEGIN IMMEDIATE" }).execute(&mut *conn).await?;
    Ok(())
}

/// Ends the transaction `begin` started. When its work went through, what it set off (`effects`) goes into the outbox
/// first, and both are kept together. Else, or when the outbox refuses the rows, it's all rolled back.
pub async fn finish<T>(conn: &mut AnyConnection, outbox: Option<&mut Outbox>, effects: &Effects, done: Result<T>) -> Result<T> {
    let done = match (done, outbox) {
        (Ok(value), Some(outbox)) => outbox.send(&mut *conn, effects).await.map(|()| value),
        (done, _) => done,
    };
    match done {
        Ok(value) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            Ok(value)
        }
        Err(error) => {
            sqlx::query("ROLLBACK").execute(&mut *conn).await.ok();
            Err(error)
        }
    }
}

/// Writes the rows for what a write by `actor` set off: each project it changed, the settings, and each event told.
async fn record(conn: &mut AnyConnection, changed: &[&String], settings: bool, told: &[(String, String, String)], actor: &Actor) -> Result<()> {
    let mut rows: Vec<(&str, Option<&str>, Option<&str>)> = vec![];
    for project in changed {
        rows.push(("project.changed", Some(project.as_str()), None));
    }
    if settings {
        rows.push(("settings", None, None));
    }
    for (kind, project, subject) in told {
        rows.push((kind.as_str(), Some(project.as_str()), Some(subject.as_str())));
    }
    let now = stamp();
    for (kind, project, subject) in rows {
        sqlx::query(&sql("INSERT INTO changes (kind, project, subject, actor, owner, session, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"))
            .bind(kind)
            .bind(project)
            .bind(subject)
            .bind(&actor.name)
            .bind(i32::from(actor.owner))
            .bind(actor.session.as_deref())
            .bind(&now)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The rows after `after` (0, or none, for the oldest kept), oldest first, a page at a time: `{changes, last}`, `last`
/// being the id to ask after next (`after` itself when there's nothing new).
pub async fn after(conn: &mut AnyConnection, after: Option<&str>) -> Result<Value> {
    let after: i64 = match after.filter(|a| !a.is_empty()) {
        None => 0,
        Some(a) => {
            a.parse().ok().filter(|n| *n >= 0).ok_or_else(|| ApiError::bad_request(format!("\"after\" is a change's id, a whole number, not \"{a}\"")))?
        }
    };
    let rows = sqlx::query(&sql(
        "SELECT CAST(id AS BIGINT) AS id, kind, project, subject, actor, CAST(owner AS BIGINT) AS owner, session, CAST(untrusted AS BIGINT) AS untrusted, cause, payload, created_at FROM changes WHERE id > ? ORDER BY id LIMIT ?",
    ))
    .bind(after)
    .bind(PAGE)
    .fetch_all(&mut *conn)
    .await?;
    let mut last = after;
    let changes: Vec<Value> = rows
        .iter()
        .map(|r| {
            let id: i64 = r.get("id");
            last = id;
            let mut change =
                json!({"id": id, "kind": r.get::<String, _>("kind"), "owner": r.get::<i64, _>("owner") == 1, "created_at": r.get::<String, _>("created_at")});
            for field in ["project", "subject", "actor", "session", "cause"] {
                if let Some(value) = r.get::<Option<String>, _>(field) {
                    change[field] = Value::String(value);
                }
            }
            if r.get::<i64, _>("untrusted") == 1 {
                change["untrusted"] = Value::Bool(true);
            }
            if let Some(payload) = r.get::<Option<String>, _>("payload") {
                change["payload"] = serde_json::from_str(&payload).unwrap_or(Value::Null);
            }
            change
        })
        .collect();
    Ok(json!({"changes": changes, "last": last}))
}
