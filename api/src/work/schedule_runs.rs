// A schedule's runs, written for the local app's clock (ORR-1176, part of ORR-1093): the clock stays the local app's,
// as only it starts sessions, but what a run keeps goes through here. Taking the next run (`claimNext`), recording a
// run (`record`, which also marks an issue schedule's issue as its), and the events an event schedule's minute holds
// back (`schedule_held`: hold one, take one, drop them all, by the schedule's id alone, as `catchUp` reads them). Only the local app calls these (`Orrery-Came: server`).
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::Effects;
use serde_json::{json, Value};
use sqlx::{AnyConnection, Row};

/// What a run came to, as `ScheduleRun['outcome']` has it.
const OUTCOMES: [&str; 4] = ["made", "sent", "skipped", "failed"];

pub struct ScheduleRuns<'c> {
    conn: &'c mut AnyConnection,
    pub effects: Effects,
    pub outbox: Option<Outbox>,
}

/// The text field `key` of `body`: none when it's left out or null, a 400 when it's anything but text.
fn text<'b>(body: &'b Value, key: &str) -> Result<Option<&'b str>> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(ApiError::bad_request(format!("\"{key}\" is text"))),
    }
}

impl<'c> ScheduleRuns<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        ScheduleRuns { conn, effects: Effects::default(), outbox: None }
    }

    /// The schedule's kind, or a 404 when the project has no such schedule.
    async fn kind(&mut self, project: &str, id: i64) -> Result<String> {
        sqlx::query(&sql("SELECT kind FROM schedules WHERE project = ? AND id = ?"))
            .bind(project)
            .bind(id)
            .fetch_optional(&mut *self.conn)
            .await?
            .map(|row| row.get::<String, _>("kind"))
            .ok_or_else(|| ApiError::not_found(format!("No schedule {id} in {project}")))
    }

    /// Takes its next run (`claimNext`): `{from, to, enabled}` moves `next_run` from what the clock read (`from`) to
    /// the run after it (`to`, null for a one-off, which `enabled: false` turns off). False when another server, or
    /// another call, took it first, as `next_run` isn't `from` any more.
    pub async fn claim(&mut self, project: &str, id: i64, body: &Value) -> Result<bool> {
        self.kind(project, id).await?;
        let Some(from) = text(body, "from")? else {
            return Err(ApiError::bad_request("Send \"from\": the next run the clock read, which this takes"));
        };
        let to = text(body, "to")?;
        let Some(enabled) = body.get("enabled").and_then(Value::as_bool) else {
            return Err(ApiError::bad_request("Send \"enabled\": false once a one-off has run, else true"));
        };
        let done = sqlx::query(&sql("UPDATE schedules SET next_run = ?, enabled = ? WHERE project = ? AND id = ? AND next_run = ?"))
            .bind(to)
            .bind(i32::from(enabled))
            .bind(project)
            .bind(id)
            .bind(from)
            .execute(&mut *self.conn)
            .await?;
        Ok(done.rows_affected() > 0)
    }

    /// Records a run (`record`): `{at, outcome, issue?, note?, subject?}`. An issue schedule's run that made its issue
    /// marks that issue as the schedule's, in the same transaction, so a run's issue is never left unmarked. The project's
    /// schedules are said to have changed, as their runs did.
    pub async fn record(&mut self, project: &str, id: i64, body: &Value) -> Result<Value> {
        let kind = self.kind(project, id).await?;
        let Some(at) = text(body, "at")? else {
            return Err(ApiError::bad_request("Send \"at\": when the run was"));
        };
        let outcome = text(body, "outcome")?.unwrap_or_default();
        if !OUTCOMES.contains(&outcome) {
            return Err(ApiError::bad_request(format!("\"outcome\" is one of {}", OUTCOMES.join(", "))));
        }
        let (issue, note, subject) = (text(body, "issue")?, text(body, "note")?, text(body, "subject")?);
        let marks = kind == "issue" && outcome == "made" && issue.is_some();
        self.effects.schedules.push(project.into());
        if marks {
            self.effects.changed.push(project.into());
        }
        changes::begin(self.conn).await?;
        let done = self.insert(project, id, at, outcome, issue, note, subject, marks).await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let mut run = json!({"at": at, "outcome": outcome});
        for (key, value) in [("issue", issue), ("note", note), ("subject", subject)] {
            if let Some(value) = value {
                run[key] = json!(value);
            }
        }
        Ok(run)
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert(
        &mut self,
        project: &str,
        id: i64,
        at: &str,
        outcome: &str,
        issue: Option<&str>,
        note: Option<&str>,
        subject: Option<&str>,
        marks: bool,
    ) -> Result<()> {
        sqlx::query(&sql("INSERT INTO schedule_runs (schedule, at, outcome, issue, note, subject) VALUES (?, ?, ?, ?, ?, ?)"))
            .bind(id)
            .bind(at)
            .bind(outcome)
            .bind(issue)
            .bind(note)
            .bind(subject)
            .execute(&mut *self.conn)
            .await?;
        if marks {
            sqlx::query(&sql("UPDATE issues SET schedule = ? WHERE project = ? AND id = ?"))
                .bind(id)
                .bind(project)
                .bind(issue)
                .execute(&mut *self.conn)
                .await?;
        }
        Ok(())
    }

    /// Holds an event back for the schedule's next minute (`hearOne`): `{event, at}`, the event as JSON text. A newer
    /// event for the same subject takes the older one's place, keeping when it was first held.
    pub async fn hold(&mut self, id: i64, subject: &str, body: &Value) -> Result<()> {
        let there = sqlx::query(&sql("SELECT 1 AS one FROM schedules WHERE id = ?")).bind(id).fetch_optional(&mut *self.conn).await?;
        if there.is_none() {
            return Err(ApiError::not_found(format!("No schedule {id}")));
        }
        let (Some(event), Some(at)) = (text(body, "event")?, text(body, "at")?) else {
            return Err(ApiError::bad_request("Send \"event\", the event as JSON text, and \"at\", when it was held"));
        };
        sqlx::query(&sql(
            "INSERT INTO schedule_held (schedule, subject, event, at) VALUES (?, ?, ?, ?) ON CONFLICT (schedule, subject) DO UPDATE SET event = excluded.event",
        ))
        .bind(id)
        .bind(subject)
        .bind(event)
        .bind(at)
        .execute(&mut *self.conn)
        .await?;
        Ok(())
    }

    /// Takes a held event out to run it (`catchUp`): false when another server got there first. One for a schedule
    /// since deleted is simply not there.
    pub async fn take(&mut self, id: i64, subject: &str) -> Result<bool> {
        let done = sqlx::query(&sql("DELETE FROM schedule_held WHERE schedule = ? AND subject = ?")).bind(id).bind(subject).execute(&mut *self.conn).await?;
        Ok(done.rows_affected() > 0)
    }

    /// Drops what a schedule held back, as it's switched off or gone.
    pub async fn drop_held(&mut self, id: i64) -> Result<()> {
        sqlx::query(&sql("DELETE FROM schedule_held WHERE schedule = ?")).bind(id).execute(&mut *self.conn).await?;
        Ok(())
    }
}
