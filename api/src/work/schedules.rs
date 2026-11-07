// The schedules, reading them (ORR-930, ORR-950): what `list`, `get` and `listAcross` in web/server/utils/schedules.ts
// do, answering as their `GET` routes do. Making, changing and running them stays the Nuxt server's: a run starts a
// session and a write can set one off, which waits on how the local app hears the board (ORR-929).
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::work::presets::server_id;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::cmp::Ordering;

/// How many of its latest runs a schedule comes with (`RUNS`).
const RUNS: i64 = 10;

const COLUMNS: &str = "CAST(id AS BIGINT) AS id, project, kind, title, notes, cron, at, timezone, place, milestone, priority, labels,
    CAST(ask AS BIGINT) AS ask, CAST(skip_open AS BIGINT) AS skip_open, CAST(only_if_changed AS BIGINT) AS only_if_changed,
    CAST(untrusted AS BIGINT) AS untrusted, CAST(enabled AS BIGINT) AS enabled, next_run, on_event, on_filter, presets, move_from,
    CAST(across AS BIGINT) AS across, model, effort, created_by, CAST(owned AS BIGINT) AS owned, created_at, updated_at";

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// A title's order as `localeCompare` has it, near enough: by its letters ignoring case and accents, then unaccented
/// first, then lower case before upper. Not `natural_cmp`, as this `localeCompare` doesn't read numbers by their value.
fn title_cmp(a: &str, b: &str) -> Ordering {
    let letters = |t: &str| crate::text::base_letters(t);
    letters(a).cmp(&letters(b)).then_with(|| a.to_lowercase().cmp(&b.to_lowercase())).then_with(|| b.cmp(a))
}

pub struct Schedules<'c> {
    pub conn: &'c mut AnyConnection,
}

impl<'c> Schedules<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Schedules { conn }
    }

    /// The schedule as the API gives it (`scheduleOf`): with its latest runs, and how many runs it holds back.
    async fn schedule_of(&mut self, row: &AnyRow) -> Result<Value> {
        let id: i64 = row.get("id");
        let runs = sqlx::query(&sql("SELECT at, outcome, issue, note, subject FROM schedule_runs WHERE schedule = ? ORDER BY id DESC LIMIT ?"))
            .bind(id)
            .bind(RUNS)
            .fetch_all(&mut *self.conn)
            .await?;
        let held: i64 =
            sqlx::query(&sql("SELECT CAST(count(*) AS BIGINT) AS n FROM schedule_held WHERE schedule = ?")).bind(id).fetch_one(&mut *self.conn).await?.get("n");
        let text = |key: &str| row.get::<Option<String>, _>(key).filter(|t| !t.is_empty());
        let flag = |key: &str| row.get::<i64, _>(key) != 0;
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        out.insert("project".into(), json!(row.get::<String, _>("project")));
        out.insert("kind".into(), json!(row.get::<String, _>("kind")));
        out.insert("title".into(), json!(row.get::<String, _>("title")));
        // Left out when null, as `?? undefined` leaves them.
        for (key, column) in [("notes", "notes"), ("cron", "cron"), ("at", "at"), ("on", "on_event")] {
            if let Some(value) = row.get::<Option<String>, _>(column) {
                out.insert(key.into(), json!(value));
            }
        }
        if let Some(filter) = text("on_filter") {
            out.insert("on_filter".into(), parsed(&filter));
        }
        out.insert("presets".into(), parsed(&row.get::<String, _>("presets")));
        out.insert("move_from".into(), parsed(&row.get::<String, _>("move_from")));
        out.insert("timezone".into(), json!(row.get::<String, _>("timezone")));
        out.insert("column".into(), json!(row.get::<String, _>("place")));
        for (key, column) in [("milestone", "milestone"), ("priority", "priority")] {
            if let Some(value) = row.get::<Option<String>, _>(column) {
                out.insert(key.into(), json!(value));
            }
        }
        out.insert("labels".into(), parsed(&row.get::<String, _>("labels")));
        for key in ["ask", "skip_open", "only_if_changed", "untrusted", "enabled"] {
            out.insert(key.into(), json!(flag(key)));
        }
        if let Some(next) = row.get::<Option<String>, _>("next_run") {
            out.insert("next_run".into(), json!(next));
        }
        let runs: Vec<Value> = runs
            .iter()
            .map(|r| {
                let mut run = Map::new();
                run.insert("at".into(), json!(r.get::<String, _>("at")));
                run.insert("outcome".into(), json!(r.get::<String, _>("outcome")));
                for key in ["issue", "note"] {
                    if let Some(value) = r.get::<Option<String>, _>(key) {
                        run.insert(key.into(), json!(value));
                    }
                }
                if let Some(subject) = r.get::<Option<String>, _>("subject").filter(|s| !s.is_empty()) {
                    run.insert("subject".into(), json!(subject));
                }
                Value::Object(run)
            })
            .collect();
        out.insert("runs".into(), Value::Array(runs));
        if held != 0 {
            out.insert("held".into(), json!(held));
        }
        out.insert("created_by".into(), json!(row.get::<String, _>("created_by")));
        out.insert("protected".into(), json!(flag("owned")));
        out.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
        out.insert("updated_at".into(), json!(row.get::<String, _>("updated_at")));
        if let Some(across) = row.get::<Option<i64>, _>("across").filter(|a| *a != 0) {
            out.insert("across".into(), json!(across));
        }
        for key in ["model", "effort"] {
            if let Some(value) = text(key) {
                out.insert(key.into(), json!(value));
            }
        }
        Ok(Value::Object(out))
    }

    /// Every project's schedules, or one project's: soonest first, those with no next run last, ties by title (ORR-981).
    pub async fn list(&mut self, project: Option<&str>) -> Result<Value> {
        let rows = match project {
            Some(project) => {
                let found = sqlx::query(&sql("SELECT 1 FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await?;
                if found.is_none() {
                    return Err(ApiError::not_found(format!("No project \"{project}\"")));
                }
                sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM schedules WHERE project = ?"))).bind(project).fetch_all(&mut *self.conn).await?
            }
            None => sqlx::query(&format!("SELECT {COLUMNS} FROM schedules")).fetch_all(&mut *self.conn).await?,
        };
        let mut listed = Vec::new();
        for row in &rows {
            listed.push(self.schedule_of(row).await?);
        }
        let due = |s: &Value| s.get("next_run").and_then(Value::as_str).unwrap_or("~").to_string();
        let title = |s: &Value| s["title"].as_str().unwrap_or_default().to_string();
        listed.sort_by(|a, b| due(a).cmp(&due(b)).then_with(|| title_cmp(&title(a), &title(b))));
        Ok(Value::Array(listed))
    }

    /// The schedule by its number or its full id (`sch-12-x7k2m9qd`), with its latest runs, or a 404.
    pub async fn get(&mut self, project: &str, sent: &str, uid: &str) -> Result<Value> {
        let id = server_id("sch-", "schedule", sent, uid)?;
        let row = sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM schedules WHERE project = ? AND id = ?")))
            .bind(project)
            .bind(id)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No schedule {id} in {project}")))?;
        self.schedule_of(&row).await
    }

    /// Every schedule across projects, oldest first (`listAcross`), each with the projects it's made on.
    pub async fn across(&mut self) -> Result<Value> {
        let rows = sqlx::query("SELECT CAST(id AS BIGINT) AS id, projects, skip, body, created_by, created_at, updated_at FROM schedules_across ORDER BY id")
            .fetch_all(&mut *self.conn)
            .await?;
        let mut out = Vec::new();
        for row in &rows {
            let id: i64 = row.get("id");
            let copies = sqlx::query(&sql("SELECT project FROM schedules WHERE across = ? ORDER BY project")).bind(id).fetch_all(&mut *self.conn).await?;
            let mut fields = match parsed(&row.get::<String, _>("body")) {
                Value::Object(fields) => fields,
                _ => Map::new(),
            };
            // `enabled` defaults to on, as `{enabled = true, ...fields}` reads it, and is kept as a flag.
            let enabled = fields.remove("enabled").map_or(true, |e| !matches!(e, Value::Null | Value::Bool(false)) && e != json!(0) && e != json!(""));
            let title = fields.get("title").map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_string)).unwrap_or_else(|| "undefined".into());
            let projects: String = row.get("projects");
            fields.insert("enabled".into(), json!(enabled));
            fields.insert("id".into(), json!(id));
            fields.insert("title".into(), json!(title));
            fields.insert("projects".into(), if projects == "*" { json!("*") } else { parsed(&projects) });
            fields.insert("skip".into(), parsed(&row.get::<String, _>("skip")));
            fields.insert("on_projects".into(), Value::Array(copies.iter().map(|c| json!(c.get::<String, _>("project"))).collect()));
            fields.insert("created_by".into(), json!(row.get::<String, _>("created_by")));
            fields.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
            fields.insert("updated_at".into(), json!(row.get::<String, _>("updated_at")));
            out.push(Value::Object(fields));
        }
        Ok(Value::Array(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_titles_as_locale_compare_does() {
        let mut titles = vec!["b", "B", "a", "Ä", "item 9", "item 10"];
        titles.sort_by(|a, b| title_cmp(a, b));
        assert_eq!(titles, ["a", "Ä", "b", "B", "item 10", "item 9"]);
    }
}
