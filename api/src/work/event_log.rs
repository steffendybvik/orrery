// The event log's reads and resolve (ORR-1088): what web/server/utils/event-log.ts `list` and `resolve` do with the
// `events` table. Writing a line (the page's error reports, the local app's own `note`s and the roadmap's activity)
// stays the Nuxt server's for now, as it scrubs secrets' values out with the machine's key and hears each line as it's
// written. A resolve says each line it changed in the outbox (`event.logged`), so the local app pushes it to open
// pages' bells as its own resolve did.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{stamp, Actor, Effects};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

/// `EVENT_LEVELS` in web/shared/roadmap/events.ts.
pub(crate) const LEVELS: [&str; 3] = ["error", "warn", "info"];
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
