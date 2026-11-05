// The outbox (ORR-929, the `rust-api-events` decision): a row for each thing a write set off, so the local app can
// follow a board it doesn't front, from `GET /api/changes?after=<id>`, and carry on from where it was after a gap. For
// now the rows go in just after each write, on its connection; they move inside each domain's transaction next, and
// the Nuxt server's own writes add theirs after that. Nothing reads them yet: the reply headers still carry what changed.
use crate::db::sql;
use crate::docs::{stamp, Actor, Effects};
use crate::error::{ApiError, Result};
use serde_json::{json, Value};
use sqlx::{AnyConnection, Row};

/// How many rows one read gives at most.
const PAGE: i64 = 500;

/// Writes what `effects` says a write by `actor` set off: each project it changed, the settings, and each event told.
pub async fn record(conn: &mut AnyConnection, effects: &Effects, actor: &Actor) -> Result<()> {
    let mut rows: Vec<(&str, Option<&str>, Option<&str>)> = vec![];
    for project in &effects.changed {
        rows.push(("project.changed", Some(project.as_str()), None));
    }
    if effects.settings {
        rows.push(("settings", None, None));
    }
    for (kind, project, subject) in &effects.told {
        rows.push((kind.as_str(), Some(project.as_str()), Some(subject.as_str())));
    }
    let now = stamp();
    for (kind, project, subject) in rows {
        sqlx::query(&sql("INSERT INTO changes (kind, project, subject, actor, owner, session, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"))
            .bind(kind)
            .bind(project)
            .bind(subject)
            .bind(&actor.name)
            .bind(i64::from(actor.owner))
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
