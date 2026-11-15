// A project's milestones, written (ORR-974): what `createMilestone`, `updateMilestone` and `deleteMilestone` do
// (web/server/store/milestones.ts), answering as their routes do. Reading them is `plans.rs`. Each write puts what it set
// off in the outbox inside its transaction (ORR-929), and the router tells the Nuxt server's hooks from the reply.
use crate::board::issues::Issues;
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{js, stamp, Actor, Effects};
use serde_json::{Map, Value};
use sqlx::{AnyConnection, Row};

const FIELDS: [&str; 4] = ["title", "summary", "priority", "position"];
const PRIORITIES: [&str; 4] = ["P0", "P1", "P2", "P3"];

/// A body as `checkInput(body, MILESTONE_FIELDS, partial)` takes it: `title` is required unless `partial`, `summary` and
/// `priority` may be null.
fn check_input(body: &Value, partial: bool) -> Result<Map<String, Value>> {
    let Some(sent) = body.as_object() else {
        return Err(ApiError::bad_request("The body should be a JSON object"));
    };
    let mut problems = vec![];
    for key in sent.keys() {
        if !FIELDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", FIELDS.join(", ")));
        }
    }
    let mut input = Map::new();
    for key in FIELDS {
        let Some(value) = sent.get(key) else {
            if !partial && key == "title" {
                problems.push("missing \"title\"".into());
            }
            continue;
        };
        if value.is_null() {
            if key == "summary" || key == "priority" {
                input.insert(key.into(), Value::Null);
            } else {
                problems.push(format!("\"{key}\" can't be null"));
            }
            continue;
        }
        if key == "position" {
            if value.is_number() {
                input.insert(key.into(), value.clone());
            } else {
                problems.push(format!("\"{key}\" should be a number, not {}", js(value)));
            }
            continue;
        }
        let Some(text) = value.as_str() else {
            problems.push(format!("\"{key}\" should be a string, not {}", js(value)));
            continue;
        };
        if key == "priority" && !PRIORITIES.contains(&text) {
            problems.push(format!("\"priority\" is \"{text}\", not one of {} (or null)", PRIORITIES.join(", ")));
            continue;
        }
        if key == "title" && text.trim().is_empty() {
            problems.push("\"title\" can't be empty".into());
            continue;
        }
        input.insert(key.into(), value.clone());
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(input)
}

fn text(input: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    input.get(key).map(|v| v.as_str().map(str::to_string))
}

pub struct Milestones<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Milestones<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Milestones { conn, effects: Effects::default(), outbox: None }
    }

    /// The milestone's id, from its id, an old id or its full form, or a 404, as `milestoneId` and `milestoneRow` give it.
    pub(crate) async fn milestone_id(&mut self, project: &str, sent: &str) -> Result<(String, bool)> {
        let id = Issues::new(self.conn).resolve(project, sent, true).await?;
        let row = sqlx::query(&sql("SELECT CAST(owned AS BIGINT) AS owned FROM milestones WHERE project = ? AND id = ?"))
            .bind(project)
            .bind(&id)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No milestone \"{id}\" in {project}")))?;
        Ok((id, row.get::<i64, _>("owned") != 0))
    }

    async fn touch_project(&mut self, project: &str) -> Result<()> {
        sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(stamp()).bind(project).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// The project's next milestone number, taken in one statement so two writers never get the same one; one that's
    /// still a milestone's id or an old one is skipped (`nextId`).
    async fn next_id(&mut self, project: &str) -> Result<String> {
        loop {
            let row =
                sqlx::query(&sql("UPDATE projects SET next_milestone = next_milestone + 1 WHERE id = ? RETURNING CAST(next_milestone - 1 AS BIGINT) AS n"))
                    .bind(project)
                    .fetch_one(&mut *self.conn)
                    .await?;
            let id = row.get::<i64, _>("n").to_string();
            let taken = sqlx::query(&sql(
                "SELECT 1 FROM milestones WHERE project = ? AND id = ? UNION SELECT 1 FROM milestone_aliases WHERE project = ? AND alias = ?",
            ))
            .bind(project)
            .bind(&id)
            .bind(project)
            .bind(&id)
            .fetch_optional(&mut *self.conn)
            .await?;
            if taken.is_none() {
                return Ok(id);
            }
        }
    }

    async fn next_position(&mut self, project: &str) -> Result<f64> {
        let row = sqlx::query(&sql("SELECT CAST(max(position) AS DOUBLE PRECISION) AS n FROM milestones WHERE project = ?"))
            .bind(project)
            .fetch_one(&mut *self.conn)
            .await?;
        Ok(row.get::<Option<f64>, _>("n").unwrap_or(-1.0) + 1.0)
    }

    async fn finish<T>(&mut self, done: Result<T>) -> Result<T> {
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Makes a milestone with the project's next number: its id.
    pub async fn create(&mut self, project: &str, body: &Value, actor: &Actor) -> Result<String> {
        Issues::new(self.conn).project(project).await?;
        let input = check_input(body, false)?;
        let title = input["title"].as_str().unwrap_or_default().trim().to_string();
        let now = stamp();
        changes::begin(self.conn).await?;
        let done: Result<String> = async {
            let id = self.next_id(project).await?;
            let position = match input.get("position").and_then(Value::as_f64) {
                Some(at) => at,
                None => self.next_position(project).await?,
            };
            sqlx::query(&sql("INSERT INTO milestones (project, id, title, summary, priority, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
                .bind(project)
                .bind(&id)
                .bind(&title)
                .bind(text(&input, "summary").flatten())
                .bind(text(&input, "priority").flatten())
                .bind(position)
                .bind(&actor.name)
                .bind(i32::from(actor.owner))
                .bind(&now)
                .bind(&now)
                .execute(&mut *self.conn)
                .await?;
            self.touch_project(project).await?;
            self.effects.changed = vec![project.into()];
            self.effects.tell("milestone.created", project, &id);
            Ok(id)
        }
        .await;
        self.finish(done).await
    }

    /// Changes its title, summary, priority or position: its id.
    pub async fn update(&mut self, project: &str, sent: &str, body: &Value) -> Result<String> {
        let (id, _) = self.milestone_id(project, sent).await?;
        let input = check_input(body, true)?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let mut sets = vec![];
            for key in FIELDS {
                if input.contains_key(key) {
                    sets.push(format!("{key} = ?"));
                }
            }
            sets.push("updated_at = ?".into());
            let statement = sql(&format!("UPDATE milestones SET {} WHERE project = ? AND id = ?", sets.join(", ")));
            let mut query = sqlx::query(&statement);
            for key in FIELDS {
                match (key, input.get(key)) {
                    (_, None) => {}
                    ("position", Some(value)) => query = query.bind(value.as_f64()),
                    ("title", Some(value)) => query = query.bind(value.as_str().map(|t| t.trim().to_string())),
                    (_, Some(value)) => query = query.bind(value.as_str().map(str::to_string)),
                }
            }
            query.bind(stamp()).bind(project).bind(&id).execute(&mut *self.conn).await?;
            self.touch_project(project).await?;
            self.effects.changed = vec![project.into()];
            // A new title or summary reaches the sessions on its issues (ORR-984).
            if input.contains_key("title") || input.contains_key("summary") {
                self.effects.tell("milestone.changed", project, &id);
            }
            Ok(())
        }
        .await;
        self.finish(done).await?;
        Ok(id)
    }

    /// Deletes it; its issues stay, in no milestone. One the owner made is theirs to delete.
    pub async fn delete(&mut self, project: &str, sent: &str, actor: &Actor) -> Result<()> {
        let (id, owned) = self.milestone_id(project, sent).await?;
        if owned && !actor.owner {
            return Err(ApiError::refused_for(
                "issues.delete",
                format!("Deleting milestone \"{id}\" is the owner's call: milestone \"{id}\" was made by the owner"),
            ));
        }
        // Each issue it held is told as moving out of it (ORR-984).
        let held: Vec<String> = sqlx::query_scalar(&sql("SELECT id FROM issues WHERE project = ? AND milestone = ? ORDER BY id"))
            .bind(project)
            .bind(&id)
            .fetch_all(&mut *self.conn)
            .await?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            for issue in &held {
                self.effects.tell_change("issue.milestone", project, issue, Some(&id), None);
            }
            for statement in [
                "UPDATE issues SET milestone = NULL WHERE project = ? AND milestone = ?",
                "DELETE FROM milestone_aliases WHERE project = ? AND milestone = ?",
                "DELETE FROM signals WHERE project = ? AND milestone = ?",
                // Schedules that made issues in it make them in no milestone from now on.
                "UPDATE schedules SET milestone = NULL WHERE project = ? AND milestone = ?",
                "DELETE FROM milestones WHERE project = ? AND id = ?",
            ] {
                sqlx::query(&sql(statement)).bind(project).bind(&id).execute(&mut *self.conn).await?;
            }
            self.touch_project(project).await?;
            self.effects.changed = vec![project.into()];
            Ok(())
        }
        .await;
        self.finish(done).await
    }
}
