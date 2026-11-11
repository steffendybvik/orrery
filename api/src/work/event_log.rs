// The event log (ORR-1088): what web/server/utils/event-log.ts did with the `events` table, so this API is its one
// writer. Reading it (`list`), resolving a line (`resolve`), writing one (`write`) and letting old ones go (`prune`).
// What a line says is still made by the Nuxt server: it scrubs secrets' values out with the machine's key, counts a
// page's reports in memory and checks Advanced, then sends the finished line here. Only while this API can't be
// reached does it write the line itself, marked `details.local`. Each line written or resolved goes in the outbox
// (`event.logged`), so the local app pushes it to open pages' bells: a new one with `fresh`, when it's news.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{stamp, Actor, Effects};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::sync::atomic::{AtomicU64, Ordering};

/// `EVENT_LEVELS` in web/shared/roadmap/events.ts.
pub(crate) const LEVELS: [&str; 3] = ["error", "warn", "info"];
/// `ACTIVITY_FAMILIES`: the kinds under these are changes to the roadmap, kept apart from the rest when pruning.
const ACTIVITY_FAMILIES: [&str; 5] = ["issue", "comment", "milestone", "doc", "release"];
/// How long what orrery did is kept, and how long warnings and errors are, in days.
const KEEP_INFO: i64 = 7;
const KEEP_PROBLEMS: i64 = 30;
/// The most rows kept, the oldest going first: of changes to the roadmap, and of the rest.
const MAX_ACTIVITY: i64 = 5000;
const MAX_ROWS: i64 = 5000;
/// How often (in lines written) old ones are pruned, besides when the local app asks (on its start and hourly).
const PRUNE_EVERY: u64 = 200;
/// How long a message is kept, as the local app cuts it.
const MESSAGE: usize = 1000;
/// Lines written since this API started, for `PRUNE_EVERY`.
static WRITTEN: AtomicU64 = AtomicU64::new(0);

/// A dotted name, as `KIND` in event-log.ts: `page.error`, `session.started`.
fn is_kind(kind: &str) -> bool {
    !kind.is_empty()
        && kind.split('.').all(|part| {
            let mut chars = part.chars();
            chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        })
}

/// Whether a row is a change to the roadmap, in SQL: a family's names hold no `_` or `%`.
fn activity_sql() -> String {
    format!("({})", ACTIVITY_FAMILIES.iter().map(|family| format!("kind LIKE '{family}.%'")).collect::<Vec<_>>().join(" OR "))
}

/// `text` cut to `length` characters, the last an ellipsis, as `cut` in event-log.ts.
fn cut(text: &str, length: usize) -> String {
    if text.chars().count() <= length {
        return text.to_string();
    }
    let mut kept: String = text.chars().take(length - 1).collect();
    kept.push('…');
    kept
}
/// How many lines a read gives when it doesn't say, and at most.
const LIMIT: i64 = 200;
const MOST: i64 = 1000;

/// What a read asks for, as `GET /api/events/log`'s query has it.
#[derive(Default)]
pub(crate) struct Filter<'a> {
    /// One level or several, comma-separated.
    pub level: Option<&'a str>,
    /// A kind, or every one under a name (`session` is each `session.…`).
    pub kind: Option<&'a str>,
    pub project: Option<&'a str>,
    /// What a change to the roadmap was to (`ORR-12`).
    pub subject: Option<&'a str>,
    /// Only those seen since this time.
    pub since: Option<&'a str>,
    /// Unresolved ones only.
    pub open: bool,
    /// As sent: `Number(limit) || undefined`, so a blank or a word is the default.
    pub limit: Option<f64>,
}

/// `new Date(since).toISOString()` for what a query sends: a full time with its zone, or a day (midnight UTC).
fn since_of(since: &str) -> Result<String> {
    let wrong = || ApiError::bad_request(format!("\"since\" is \"{since}\", not a time (e.g. 2026-10-27T09:00:00Z)"));
    let at = match chrono::DateTime::parse_from_rfc3339(since.trim()) {
        Ok(at) => at.with_timezone(&chrono::Utc),
        Err(_) => chrono::NaiveDate::parse_from_str(since.trim(), "%Y-%m-%d").map_err(|_| wrong())?.and_hms_opt(0, 0, 0).ok_or_else(wrong)?.and_utc(),
    };
    Ok(at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// `Math.min(Math.max(1, Math.floor(limit ?? 200)), 1000)`.
fn limit_of(limit: Option<f64>) -> i64 {
    match limit {
        Some(n) if n.is_finite() && n != 0.0 => (n.floor() as i64).clamp(1, MOST),
        Some(n) if n.is_infinite() => {
            if n > 0.0 {
                MOST
            } else {
                1
            }
        }
        _ => LIMIT,
    }
}

/// A line as `eventOf` gives it: only the fields it has.
fn event_of(row: &AnyRow) -> Value {
    let mut event = Map::new();
    event.insert("id".into(), json!(row.get::<i64, _>("id")));
    event.insert("level".into(), json!(row.get::<String, _>("level")));
    event.insert("kind".into(), json!(row.get::<String, _>("kind")));
    for field in ["project", "subject"] {
        if let Some(value) = row.get::<Option<String>, _>(field).filter(|v| !v.is_empty()) {
            event.insert(field.into(), json!(value));
        }
    }
    event.insert("message".into(), json!(row.get::<String, _>("message")));
    if let Some(details) = row.get::<Option<String>, _>("details").filter(|d| !d.is_empty()) {
        event.insert("details".into(), serde_json::from_str(&details).unwrap_or(Value::Null));
    }
    event.insert("count".into(), json!(row.get::<i64, _>("count")));
    event.insert("first_seen".into(), json!(row.get::<String, _>("first_seen")));
    event.insert("last_seen".into(), json!(row.get::<String, _>("last_seen")));
    for field in ["resolved_at", "resolved_by"] {
        if let Some(value) = row.get::<Option<String>, _>(field).filter(|v| !v.is_empty()) {
            event.insert(field.into(), json!(value));
        }
    }
    Value::Object(event)
}

/// The columns a line is read with, its numbers as BIGINT on both databases.
const COLUMNS: &str = "CAST(id AS BIGINT) AS id, level, kind, project, subject, message, details, CAST(count AS BIGINT) AS count, \
     first_seen, last_seen, resolved_at, resolved_by";

pub(crate) struct EventLog<'c> {
    conn: &'c mut AnyConnection,
    effects: Effects,
    /// Set for a resolve: each line it changed goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> EventLog<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        EventLog { conn, effects: Effects::default(), outbox: None }
    }

    /// What the last resolve set off, for its reply.
    pub fn effects(self) -> Effects {
        self.effects
    }

    /// Writes a line the local app made (`PUT /api/events/log/lines`): `{level, kind, project?, subject?, message,
    /// details?, activity?}`, its texts scrubbed and cut there already. `{event, fresh}`: fresh unless it repeats one
    /// not resolved yet (same level, kind, project and message), which is a line too but no news. A change to the
    /// roadmap (`activity`) is always news. It goes into the outbox, and every PRUNE_EVERY lines old ones go.
    pub(crate) async fn write(&mut self, line: &Value) -> Result<Value> {
        let text = |key: &str| line.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
        let level = line.get("level").and_then(Value::as_str).unwrap_or_default();
        if !LEVELS.contains(&level) {
            return Err(ApiError::bad_request(format!("\"level\" is \"{level}\"; use {}", LEVELS.join(", "))));
        }
        let kind = line.get("kind").and_then(Value::as_str).unwrap_or_default();
        if !is_kind(kind) {
            return Err(ApiError::bad_request(format!("\"kind\" is \"{kind}\"; use a dotted name, e.g. page.error")));
        }
        let activity = line.get("activity").and_then(Value::as_bool).unwrap_or(false);
        let message = cut(text("message").unwrap_or(kind), MESSAGE);
        let project = text("project");
        let subject = text("subject");
        let details = match line.get("details") {
            Some(Value::Object(details)) if !details.is_empty() => Some(Value::Object(details.clone()).to_string()),
            None | Some(Value::Null) | Some(Value::Object(_)) => None,
            Some(_) => return Err(ApiError::bad_request("\"details\" is an object")),
        };
        changes::begin(self.conn).await?;
        let done = self.writing(level, kind, project, subject, &message, details, activity).await;
        let written = changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        if WRITTEN.fetch_add(1, Ordering::Relaxed) % PRUNE_EVERY == PRUNE_EVERY - 1 {
            self.prune().await?;
        }
        Ok(written)
    }

    #[allow(clippy::too_many_arguments)]
    async fn writing(
        &mut self,
        level: &str,
        kind: &str,
        project: Option<&str>,
        subject: Option<&str>,
        message: &str,
        details: Option<String>,
        activity: bool,
    ) -> Result<Value> {
        let again = !activity
            && sqlx::query(&sql(
                "SELECT id FROM events WHERE level = ? AND kind = ? AND coalesce(project, '') = ? AND message = ? AND resolved_at IS NULL LIMIT 1",
            ))
            .bind(level)
            .bind(kind)
            .bind(project.unwrap_or_default())
            .bind(message)
            .fetch_optional(&mut *self.conn)
            .await?
            .is_some();
        let at = stamp();
        let row = sqlx::query(&sql(&format!(
            "INSERT INTO events (level, kind, project, subject, message, details, count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) \
             RETURNING {COLUMNS}"
        )))
        .bind(level)
        .bind(kind)
        .bind(project)
        .bind(subject)
        .bind(message)
        .bind(details)
        .bind(&at)
        .bind(&at)
        .fetch_one(&mut *self.conn)
        .await?;
        let event = event_of(&row);
        let mut told = event.clone();
        if !again {
            told["fresh"] = json!(true);
        }
        self.effects.logged.push(told);
        Ok(json!({"event": event, "fresh": !again}))
    }

    /// Lets go of what's old: info after KEEP_INFO days, the rest after KEEP_PROBLEMS, and the oldest past MAX_ACTIVITY
    /// changes to the roadmap and past MAX_ROWS of the rest, so many changes can't push an error out. How many went.
    pub(crate) async fn prune(&mut self) -> Result<u64> {
        let before = |days: i64| (chrono::Utc::now() - chrono::Duration::days(days)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let mut gone = sqlx::query(&sql("DELETE FROM events WHERE level = 'info' AND last_seen < ?"))
            .bind(before(KEEP_INFO))
            .execute(&mut *self.conn)
            .await?
            .rows_affected();
        gone += sqlx::query(&sql("DELETE FROM events WHERE level <> 'info' AND last_seen < ?"))
            .bind(before(KEEP_PROBLEMS))
            .execute(&mut *self.conn)
            .await?
            .rows_affected();
        let activity = activity_sql();
        for (which, most) in [(activity.clone(), MAX_ACTIVITY), (format!("NOT {activity}"), MAX_ROWS)] {
            gone += sqlx::query(&sql(&format!(
                "DELETE FROM events WHERE {which} AND id NOT IN (SELECT id FROM events WHERE {which} ORDER BY last_seen DESC, id DESC LIMIT {most})"
            )))
            .execute(&mut *self.conn)
            .await?
            .rows_affected();
        }
        Ok(gone)
    }

    /// The lines that match, newest first (by when they were last seen).
    pub(crate) async fn list(&mut self, filter: &Filter<'_>) -> Result<Value> {
        let mut wheres: Vec<String> = vec![];
        let mut binds: Vec<String> = vec![];
        if let Some(level) = filter.level.filter(|l| !l.is_empty()) {
            let levels: Vec<&str> = level.split(',').map(str::trim).filter(|l| !l.is_empty()).collect();
            if let Some(wrong) = levels.iter().find(|l| !LEVELS.contains(l)) {
                return Err(ApiError::bad_request(format!("\"level\" has \"{wrong}\"; use {}", LEVELS.join(", "))));
            }
            if !levels.is_empty() {
                wheres.push(format!("level IN ({})", vec!["?"; levels.len()].join(", ")));
                binds.extend(levels.iter().map(|l| l.to_string()));
            }
        }
        if let Some(kind) = filter.kind.filter(|k| !k.is_empty()) {
            wheres.push("(kind = ? OR kind LIKE ? ESCAPE '\\')".into());
            let escaped: String = kind.chars().flat_map(|c| if matches!(c, '\\' | '%' | '_') { vec!['\\', c] } else { vec![c] }).collect();
            binds.extend([kind.to_string(), format!("{escaped}.%")]);
        }
        if let Some(project) = filter.project.filter(|p| !p.is_empty()) {
            wheres.push("project = ?".into());
            binds.push(project.into());
        }
        if let Some(subject) = filter.subject.filter(|s| !s.is_empty()) {
            wheres.push("subject = ?".into());
            binds.push(subject.into());
        }
        if let Some(since) = filter.since.filter(|s| !s.is_empty()) {
            wheres.push("last_seen >= ?".into());
            binds.push(since_of(since)?);
        }
        if filter.open {
            wheres.push("resolved_at IS NULL".into());
        }
        let wheres = if wheres.is_empty() { String::new() } else { format!("WHERE {}", wheres.join(" AND ")) };
        let statement = sql(&format!("SELECT {COLUMNS} FROM events {wheres} ORDER BY last_seen DESC, id DESC LIMIT {}", limit_of(filter.limit)));
        let mut query = sqlx::query(&statement);
        for bind in &binds {
            query = query.bind(bind);
        }
        let rows = query.fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(rows.iter().map(event_of).collect()))
    }

    /// Marks line `id` dealt with, and its repeats not resolved yet, so the next one like it is news again. `by` keeps
    /// who resolved it when that isn't the owner (ORR-420): the bell still shows it until the owner looks.
    pub(crate) async fn resolve(&mut self, id: i64, by: &Actor) -> Result<Value> {
        changes::begin(self.conn).await?;
        let done = self.resolving(id, by).await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn resolving(&mut self, id: i64, by: &Actor) -> Result<Value> {
        let at = stamp();
        let who = (!by.owner).then(|| by.name.clone());
        let row = sqlx::query(&sql(&format!(
            "UPDATE events SET resolved_by = CASE WHEN resolved_at IS NULL THEN ? ELSE resolved_by END, resolved_at = coalesce(resolved_at, ?) \
             WHERE id = ? RETURNING {COLUMNS}"
        )))
        .bind(who.clone())
        .bind(&at)
        .bind(id)
        .fetch_optional(&mut *self.conn)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("No event {id}")))?;
        let event = event_of(&row);
        let (level, kind, project, message): (String, String, Option<String>, String) =
            (row.get("level"), row.get("kind"), row.get("project"), row.get("message"));
        let repeats = sqlx::query(&sql(&format!(
            "UPDATE events SET resolved_at = ?, resolved_by = ? WHERE resolved_at IS NULL AND level = ? AND kind = ? \
             AND coalesce(project, '') = ? AND message = ? RETURNING {COLUMNS}"
        )))
        .bind(&at)
        .bind(who)
        .bind(&level)
        .bind(&kind)
        .bind(project.unwrap_or_default())
        .bind(&message)
        .fetch_all(&mut *self.conn)
        .await?;
        // In the order the store hears them: the repeats, then the line itself.
        self.effects.logged.extend(repeats.iter().map(event_of));
        self.effects.logged.push(event.clone());
        Ok(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_is_a_dotted_name() {
        for kind in ["page.error", "session.started", "api.unreachable", "a", "issue.due_date", "x-y.z9"] {
            assert!(is_kind(kind), "{kind}");
        }
        for kind in ["", "Page.error", "page.", ".page", "page..error", "9page", "page error", "page.Error"] {
            assert!(!is_kind(kind), "{kind}");
        }
    }

    #[test]
    fn a_long_text_is_cut_with_an_ellipsis() {
        assert_eq!(cut("short", 10), "short");
        assert_eq!(cut("abcdefghijk", 5), "abcd…");
        assert_eq!(cut("ééééé", 5), "ééééé", "characters, not bytes");
    }

    #[test]
    fn a_limit_is_a_whole_number_from_one_to_a_thousand() {
        assert_eq!(limit_of(None), 200);
        assert_eq!(limit_of(Some(0.0)), 200, "Number('0') || undefined is the default");
        assert_eq!(limit_of(Some(f64::NAN)), 200);
        assert_eq!(limit_of(Some(5.7)), 5);
        assert_eq!(limit_of(Some(-3.0)), 1);
        assert_eq!(limit_of(Some(5000.0)), 1000);
        assert_eq!(limit_of(Some(f64::INFINITY)), 1000);
    }

    #[test]
    fn since_is_a_time_with_its_zone_or_a_day() {
        assert_eq!(since_of("2026-10-27T09:00:00Z").unwrap(), "2026-10-27T09:00:00.000Z");
        assert_eq!(since_of("2026-10-27T11:00:00+02:00").unwrap(), "2026-10-27T09:00:00.000Z");
        assert_eq!(since_of("2026-10-27").unwrap(), "2026-10-27T00:00:00.000Z");
        assert_eq!(since_of("soon").unwrap_err().message, "\"since\" is \"soon\", not a time (e.g. 2026-10-27T09:00:00Z)");
    }
}
