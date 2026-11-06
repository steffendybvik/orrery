// The outbox (ORR-929, the `rust-api-events` decision): a row for each thing a write set off, so the local app can
// follow a board it doesn't front, from `GET /api/changes?after=<id>`, and carry on from where it was after a gap. The
// rows go in inside each write's own transaction (`finish`), so a rolled-back write says nothing and a committed one is
// never lost. The Nuxt server's own writes add theirs next. The same path streams them as server-sent events (`stream`),
// woken by `wake()` once a write has committed, and rows older than a week are pruned. Nothing reads them yet: the
// reply headers still carry what changed.
use crate::db::sql;
use crate::docs::{stamp, Actor, Effects, Told};
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

/// A write request's way into the outbox: who's writing, and what its transactions have recorded so far. A request can
/// run more than one (renaming a section, then moving it), and each records only what the ones before it didn't.
pub struct Outbox {
    actor: Actor,
    changed: Vec<String>,
    settings: bool,
    epics: bool,
    told: usize,
}

impl Outbox {
    pub fn new(actor: Actor) -> Self {
        Outbox { actor, changed: vec![], settings: false, epics: false, told: 0 }
    }

    /// Records what `effects` holds that this request hasn't recorded yet, on `conn`, inside its transaction.
    async fn send(&mut self, conn: &mut AnyConnection, effects: &Effects) -> Result<()> {
        let changed: Vec<&String> = effects.changed.iter().filter(|p| !self.changed.contains(p)).collect();
        let settings = effects.settings && !self.settings;
        let epics = effects.epics && !self.epics;
        let told = &effects.told[self.told.min(effects.told.len())..];
        record(conn, &changed, settings, epics, told, &self.actor).await?;
        self.changed.extend(changed.into_iter().cloned());
        self.settings |= settings;
        self.epics |= epics;
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

/// Writes the rows for what a write by `actor` set off: each project it changed, the settings, the epics, and each event
/// told.
async fn record(conn: &mut AnyConnection, changed: &[&String], settings: bool, epics: bool, told: &[Told], actor: &Actor) -> Result<()> {
    // Each row's kind, project, subject and payload.
    type Row<'a> = (&'a str, Option<&'a str>, Option<&'a str>, Option<String>);
    let mut rows: Vec<Row> = vec![];
    for project in changed {
        rows.push(("project.changed", Some(project.as_str()), None, None));
    }
    if settings {
        rows.push(("settings", None, None, None));
    }
    if epics {
        rows.push(("epics", None, None, None));
    }
    for told in told {
        rows.push((told.kind.as_str(), Some(told.project.as_str()), Some(told.subject.as_str()), payload_of(told, actor)));
    }
    let now = stamp();
    for (kind, project, subject, payload) in rows {
        sqlx::query(&sql(
            "INSERT INTO changes (kind, project, subject, actor, owner, session, untrusted, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ))
        .bind(kind)
        .bind(project)
        .bind(subject)
        .bind(&actor.name)
        .bind(i32::from(actor.owner))
        .bind(actor.session.as_deref())
        .bind(i32::from(actor.untrusted))
        .bind(payload)
        .bind(&now)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// An event's `payload`, as the store's `tell` writes it: where its value went (`from`, `to`), and whose agent did it
/// (`person`, a member's, not the owner's); none when there's nothing to say.
fn payload_of(told: &Told, actor: &Actor) -> Option<String> {
    let mut payload = serde_json::Map::new();
    if let Some(from) = &told.from {
        payload.insert("from".into(), json!(from));
    }
    if let Some(to) = &told.to {
        payload.insert("to".into(), json!(to));
    }
    if let Some(person) = actor.person.as_ref().filter(|_| !actor.owner) {
        payload.insert("person".into(), json!(person));
    }
    (!payload.is_empty()).then(|| Value::Object(payload).to_string())
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
