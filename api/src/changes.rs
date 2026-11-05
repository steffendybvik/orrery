// The outbox (ORR-929, the `rust-api-events` decision): a row for each thing a write set off, so the local app can
// follow a board it doesn't front, from `GET /api/changes?after=<id>`, and carry on from where it was after a gap. For
// now the rows go in just after each write, on its connection; they move inside each domain's transaction next, and
// the Nuxt server's own writes add theirs after that. The same path streams them as server-sent events (`stream`),
// woken by `wake()`, and rows older than a week are pruned. Nothing reads them yet: the reply headers still carry what
// changed.
use crate::db::sql;
use crate::docs::{stamp, Actor, Effects};
use crate::error::{ApiError, Result};
use axum::response::sse::Event;
use futures_util::stream::{self, Stream};
use serde_json::{json, Value};
use sqlx::{AnyConnection, AnyPool, Row};
use std::collections::VecDeque;
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::Notify;

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
            .bind(i32::from(actor.owner))
            .bind(actor.session.as_deref())
            .bind(&now)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The id a read asks after: none, or empty, for the oldest kept; else a whole number.
pub fn cursor(after: Option<&str>) -> Result<i64> {
    match after.map(str::trim).filter(|a| !a.is_empty()) {
        None => Ok(0),
        Some(a) => a.parse().ok().filter(|n| *n >= 0).ok_or_else(|| ApiError::bad_request(format!("\"after\" is a change's id, a whole number, not \"{a}\""))),
    }
}

/// The rows after `after` (0, or none, for the oldest kept), oldest first, a page at a time: `{changes, last}`, `last`
/// being the id to ask after next (`after` itself when there's nothing new).
pub async fn after(conn: &mut AnyConnection, after: Option<&str>) -> Result<Value> {
    page(conn, cursor(after)?).await
}

/// The page after `after`. A cursor whose row isn't kept (pruned, or from another database) answers `{changes: [],
/// last: <newest>, gap: true}`: the reader has missed rows, so it reads the board again and carries on from the newest.
async fn page(conn: &mut AnyConnection, after: i64) -> Result<Value> {
    if after > 0 {
        let kept: i64 = sqlx::query(&sql("SELECT CAST(COUNT(*) AS BIGINT) AS n FROM changes WHERE id = ?")).bind(after).fetch_one(&mut *conn).await?.get("n");
        if kept == 0 {
            let newest: i64 = sqlx::query(&sql("SELECT CAST(COALESCE(MAX(id), 0) AS BIGINT) AS n FROM changes")).fetch_one(&mut *conn).await?.get("n");
            return Ok(json!({"changes": [], "last": newest, "gap": true}));
        }
    }
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

/// Wakes the open streams once a write's rows are committed, so they send them at once rather than on their next look.
/// Called after COMMIT: a stream woken before it would find nothing new and wait for its next look.
pub fn wake() {
    WAKE.notify_waiters();
}

static WAKE: Notify = Notify::const_new();

/// How often a stream looks for rows when nothing woke it: a write by another process (a second API on Postgres), or
/// one that didn't wake it.
const LOOK: Duration = Duration::from_secs(1);

/// How long rows are kept. A reader away for longer gets a gap and reads the board again.
const KEEP_DAYS: i64 = 7;

/// The rows after `after` as server-sent events, oldest first, then live: each row an event with its id, so a reader
/// that reconnects with `Last-Event-ID` carries on from it. A gap is a `gap` event with `{last}`, the newest id, which
/// the stream carries on from.
pub fn stream(pool: AnyPool, after: i64) -> impl Stream<Item = std::result::Result<Event, Infallible>> {
    stream::unfold((pool, after, VecDeque::<Value>::new()), |(pool, mut last, mut queue)| async move {
        loop {
            if let Some(change) = queue.pop_front() {
                let event = Event::default().id(change["id"].to_string()).data(change.to_string());
                return Some((Ok(event), (pool, last, queue)));
            }
            // Listening before looking, so a wake between the two isn't missed.
            let woken = WAKE.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            let read = match pool.acquire().await {
                Ok(mut conn) => page(&mut conn, last).await,
                Err(e) => Err(e.into()),
            };
            match read {
                Ok(read) if read["gap"] == Value::Bool(true) => {
                    last = read["last"].as_i64().unwrap_or(0);
                    let event = Event::default().event("gap").data(json!({"last": last}).to_string());
                    return Some((Ok(event), (pool, last, queue)));
                }
                Ok(mut read) => {
                    last = read["last"].as_i64().unwrap_or(last);
                    if let Value::Array(changes) = read["changes"].take() {
                        queue.extend(changes);
                    }
                    if queue.is_empty() {
                        tokio::select! { _ = woken => {}, _ = tokio::time::sleep(LOOK) => {} }
                    }
                }
                // The database is busy or gone for a moment (its error is logged): look again shortly.
                Err(_) => tokio::time::sleep(LOOK).await,
            }
        }
    })
}

/// Drops the rows older than a week, keeping the newest, so a reader on a quiet board still finds its cursor's row.
pub async fn prune(pool: &AnyPool) -> Result<u64> {
    let before = (chrono::Utc::now() - chrono::Duration::days(KEEP_DAYS)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut conn = pool.acquire().await?;
    let done = sqlx::query(&sql("DELETE FROM changes WHERE created_at < ? AND id < (SELECT MAX(id) FROM changes)")).bind(before).execute(&mut *conn).await?;
    Ok(done.rows_affected())
}
