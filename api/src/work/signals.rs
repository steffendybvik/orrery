// A project's signals (ORR-1087, ORR-1090): read as `listSignals` in web/server/store/signals.ts does, on the same
// `signals` rows, each as `signalOf` (web/server/store/schema.ts) gives it, answering as `GET …/signals` does; and
// written, so the API is the table's one writer. Which session a signal goes to, telling it, the stream and the
// listeners stay the Nuxt server's, as they're what this machine's sessions are doing: it picks the target, sends the
// finished row here, and tells its sessions of what comes back.
use crate::board::issues::Issues;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::stamp;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

/// How many a read gives at most, as the route asks `listSignals` for.
pub(crate) const LIMIT: i64 = 50;

const COLUMNS: &str = "CAST(id AS BIGINT) AS id, project, issue, milestone, status, release, CAST(epic AS BIGINT) AS epic, \
    CAST(schedule AS BIGINT) AS schedule, kind, note, preset, via, target, delivered_to, instructions, person, model, created_by, \
    CAST(owned AS BIGINT) AS owned, created_at";

/// Which signals: those after an id, oldest first, or the latest about an issue or a milestone.
pub(crate) enum Which<'a> {
    After(f64),
    Issue(&'a str),
    Milestone(&'a str),
    /// The owner's and members' signals from the last day for the one session orrery picks that none has heard yet
    /// (`pooledWaiting`).
    Pooled,
    /// The owner's scheduled focuses (on an issue still open) and messages from the last day that no session has heard
    /// yet (`unheardScheduled`).
    Scheduled,
    /// The owner's or a member's focus on the issue from the last ten minutes that no session has heard yet: it's on
    /// its way, so another isn't sent (`focusOnItsWay`, ORR-515).
    Focus(&'a str),
}

/// So long ago, as the signals' `created_at` has it.
fn ago(duration: chrono::Duration) -> String {
    (chrono::Utc::now() - duration).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// A day ago, as the signals' `created_at` has it.
fn a_day_ago() -> String {
    ago(chrono::Duration::days(1))
}

pub(crate) struct Signals<'c> {
    conn: &'c mut AnyConnection,
}

impl<'c> Signals<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Signals { conn }
    }

    /// The id of the project's latest signal, 0 before its first, as `lastSignal` gives it: a 404 for a project there
    /// isn't (ORR-1133).
    pub(crate) async fn last(&mut self, project: &str) -> Result<i64> {
        Issues::new(self.conn).project(project).await?;
        let row = sqlx::query(&sql("SELECT CAST(MAX(id) AS BIGINT) AS id FROM signals WHERE project = ?")).bind(project).fetch_one(&mut *self.conn).await?;
        Ok(row.get::<Option<i64>, _>("id").unwrap_or(0))
    }

    /// The project's signals, as `listSignals` gives them: a 404 for a project there isn't; an issue or milestone found
    /// by its id, an old one or its full form, and one there isn't simply has none.
    pub(crate) async fn list(&mut self, project: &str, which: Which<'_>, limit: i64) -> Result<Value> {
        let mut issues = Issues::new(self.conn);
        issues.project(project).await?;
        let rows: Vec<AnyRow> = match which {
            Which::After(after) => {
                sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM signals WHERE project = ? AND id > ? ORDER BY id LIMIT ?")))
                    .bind(project)
                    .bind(after)
                    .bind(limit)
                    .fetch_all(&mut *self.conn)
                    .await?
            }
            Which::Focus(sent) => {
                let id = Issues::new(self.conn).resolve(project, sent, false).await?;
                sqlx::query(&sql(&format!(
                    "SELECT {COLUMNS} FROM signals WHERE project = ? AND issue = ? AND kind = 'focus' AND (owned = 1 OR person IS NOT NULL) \
                     AND delivered_to = '[]' AND created_at >= ? ORDER BY id"
                )))
                .bind(project)
                .bind(id)
                .bind(ago(chrono::Duration::minutes(10)))
                .fetch_all(&mut *self.conn)
                .await?
            }
            Which::Issue(sent) | Which::Milestone(sent) => {
                let milestone = matches!(which, Which::Milestone(_));
                let id = Issues::new(self.conn).resolve(project, sent, milestone).await?;
                let column = if milestone { "milestone" } else { "issue" };
                let mut rows = sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM signals WHERE project = ? AND {column} = ? ORDER BY id DESC LIMIT ?")))
                    .bind(project)
                    .bind(id)
                    .bind(limit)
                    .fetch_all(&mut *self.conn)
                    .await?;
                rows.reverse();
                rows
            }
            Which::Pooled => {
                sqlx::query(&sql(&format!(
                    "SELECT {COLUMNS} FROM signals WHERE project = ? AND (owned = 1 OR person IS NOT NULL) AND delivered_to = '[]' \
                     AND target IS NULL AND created_at >= ? ORDER BY id"
                )))
                .bind(project)
                .bind(a_day_ago())
                .fetch_all(&mut *self.conn)
                .await?
            }
            Which::Scheduled => {
                sqlx::query(&sql(&format!(
                    "SELECT {COLUMNS} FROM signals WHERE id IN (SELECT s.id FROM signals s LEFT JOIN issues i ON i.project = s.project AND i.id = s.issue \
                     WHERE s.project = ? AND s.owned = 1 AND s.delivered_to = '[]' AND s.created_at >= ? \
                       AND ((s.kind = 'focus' AND i.schedule IS NOT NULL AND i.status NOT IN (SELECT id FROM statuses WHERE kind IN ('done', 'canceled'))) OR s.kind = 'message')) \
                     ORDER BY id"
                )))
                .bind(project)
                .bind(a_day_ago())
                .fetch_all(&mut *self.conn)
                .await?
            }
        };
        Ok(Value::Array(rows.iter().map(signal_of).collect()))
    }
}

/// How long a signal is kept (ORR-778), as `KEEP_SIGNALS`: what it's for is over within a day; the rest is the
/// Sessions page's history.
const KEEP_DAYS: i64 = 30;

/// How many times a receipt reads the list again when another session's receipt changed it first.
const TRIES: usize = 10;

impl Signals<'_> {
    /// Writes a signal the local app made (`POST …/signals`): `{kind, created_by, owned, issue?, milestone?, status?,
    /// release?, epic?, schedule?, note?, preset?, via?, target?, person?, instructions?, model?}`, its target already
    /// picked there. The row, as `signalOf` gives it.
    pub(crate) async fn write(&mut self, project: &str, sent: &Value) -> Result<Value> {
        Issues::new(self.conn).project(project).await?;
        let text = |key: &str| sent.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
        let number = |key: &str| -> Result<Option<i64>> {
            match sent.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value.as_i64().map(Some).ok_or_else(|| ApiError::bad_request(format!("\"{key}\" is a whole number"))),
            }
        };
        let kind = text("kind").unwrap_or_default();
        if !["focus", "comment", "message"].contains(&kind.as_str()) {
            return Err(ApiError::bad_request(format!("\"kind\" is \"{kind}\"; use focus, comment, message")));
        }
        let created_by = text("created_by").ok_or_else(|| ApiError::bad_request("\"created_by\" says who it's from"))?;
        let instructions = match sent.get("instructions") {
            None | Some(Value::Null) => "[]".to_string(),
            Some(Value::Array(list)) if list.iter().all(Value::is_string) => Value::Array(list.clone()).to_string(),
            Some(_) => return Err(ApiError::bad_request("\"instructions\" is a list of texts")),
        };
        let owned = sent.get("owned").and_then(Value::as_bool).unwrap_or(false);
        let row = sqlx::query(&sql(&format!(
            "INSERT INTO signals (project, issue, milestone, status, release, epic, schedule, kind, note, preset, via, target, person, \
             instructions, model, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING {COLUMNS}"
        )))
        .bind(project)
        .bind(text("issue"))
        .bind(text("milestone"))
        .bind(text("status"))
        .bind(text("release"))
        .bind(number("epic")?)
        .bind(number("schedule")?)
        .bind(&kind)
        .bind(text("note"))
        .bind(text("preset"))
        .bind(text("via"))
        .bind(text("target"))
        .bind(text("person"))
        .bind(instructions)
        .bind(text("model"))
        .bind(created_by)
        .bind(i32::from(owned))
        .bind(stamp())
        .fetch_one(&mut *self.conn)
        .await?;
        Ok(signal_of(&row))
    }

    /// Notes that a session (`to`, its name) got the signal, as `delivered` does: two saying so at once both count, as
    /// the list is only written over while it's still the one read. A 404 for a signal there isn't, a 409 when it lost
    /// every race.
    pub(crate) async fn receipt(&mut self, project: &str, id: i64, to: &str) -> Result<Value> {
        for _ in 0..TRIES {
            let row = sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM signals WHERE project = ? AND id = ?")))
                .bind(project)
                .bind(id)
                .fetch_optional(&mut *self.conn)
                .await?
                .ok_or_else(|| ApiError::not_found(format!("No signal {id} in {project}")))?;
            let was: String = row.get("delivered_to");
            let mut names: Vec<String> = serde_json::from_str(&was).unwrap_or_default();
            if !names.iter().any(|n| n == to) {
                names.push(to.to_string());
            }
            let now = Value::from(names.clone()).to_string();
            let changed = sqlx::query(&sql("UPDATE signals SET delivered_to = ? WHERE id = ? AND delivered_to = ?"))
                .bind(&now)
                .bind(id)
                .bind(&was)
                .execute(&mut *self.conn)
                .await?
                .rows_affected();
            if changed > 0 {
                let mut signal = signal_of(&row);
                signal["delivered_to"] = json!(names);
                return Ok(signal);
            }
        }
        Err(ApiError::conflict(format!("Signal {id} is being marked by too many sessions at once; try again")))
    }

    /// A session's new id (after a `/clear`) takes over the signals sent to its old one, as `renameSession` does. How
    /// many moved.
    pub(crate) async fn retarget(&mut self, project: &str, from: &str, to: &str) -> Result<u64> {
        Ok(sqlx::query(&sql("UPDATE signals SET target = ? WHERE project = ? AND target = ?"))
            .bind(to)
            .bind(project)
            .bind(from)
            .execute(&mut *self.conn)
            .await?
            .rows_affected())
    }

    /// Lets go of signals past KEEP_DAYS, heard or not (ORR-778), as `pruneSignals` does. How many went.
    pub(crate) async fn prune(&mut self) -> Result<u64> {
        let before = (chrono::Utc::now() - chrono::Duration::days(KEEP_DAYS)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        Ok(sqlx::query(&sql("DELETE FROM signals WHERE created_at < ?")).bind(before).execute(&mut *self.conn).await?.rows_affected())
    }
}

/// A signal as `signalOf` gives it: what's unset left out, the lists parsed, `owned` as `protected`.
fn signal_of(row: &AnyRow) -> Value {
    let mut out = Map::new();
    let text = |name: &str| row.get::<Option<String>, _>(name);
    let put = |out: &mut Map<String, Value>, name: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(name.to_string(), value);
        }
    };
    let list = |name: &str| serde_json::from_str::<Value>(&text(name).unwrap_or_default()).unwrap_or_else(|_| json!([]));
    put(&mut out, "id", Some(json!(row.get::<i64, _>("id"))));
    put(&mut out, "project", Some(json!(row.get::<String, _>("project"))));
    for name in ["issue", "milestone", "status", "release"] {
        put(&mut out, name, text(name).map(Value::from));
    }
    put(&mut out, "epic", row.get::<Option<i64>, _>("epic").map(Value::from));
    put(&mut out, "schedule", row.get::<Option<i64>, _>("schedule").map(Value::from));
    put(&mut out, "kind", Some(json!(row.get::<String, _>("kind"))));
    put(&mut out, "note", text("note").map(Value::from));
    put(&mut out, "preset", text("preset").map(Value::from));
    put(&mut out, "via", text("via").filter(|v| v == "chat").map(Value::from));
    put(&mut out, "target", text("target").map(Value::from));
    put(&mut out, "delivered_to", Some(list("delivered_to")));
    put(&mut out, "instructions", Some(list("instructions")));
    put(&mut out, "person", text("person").filter(|p| !p.is_empty()).map(Value::from));
    put(&mut out, "model", text("model").filter(|m| !m.is_empty()).map(Value::from));
    put(&mut out, "created_by", Some(json!(row.get::<String, _>("created_by"))));
    put(&mut out, "protected", Some(json!(row.get::<Option<i64>, _>("owned").unwrap_or(0) != 0)));
    put(&mut out, "created_at", Some(json!(row.get::<String, _>("created_at"))));
    Value::Object(out)
}
