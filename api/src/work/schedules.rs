// The schedules (ORR-930, ORR-950): what `list`, `get` and `listAcross` in web/server/utils/schedules.ts do, answering
// as their `GET` routes do; and of its writes, the owner making one theirs (`adopt`), deleting one (`delete`), and
// pausing or activating all of a project's at once (`set_all_enabled`, ORR-1082). Each write says the project's
// schedules changed (`Effects::schedules`), so the local app's scheduler reads them again. Making and changing one, and
// running them, stay the Nuxt server's for now.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::work::presets::server_id;
use crate::work::schedule_when::{next_run, when};
use crate::write::{stamp, Actor, Effects};
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
    pub effects: Effects,
    pub outbox: Option<Outbox>,
}

/// What a write needs of a schedule's row: whether it's the owner's, the schedule across projects it's made from, and
/// when it last changed.
struct Held {
    owned: bool,
    across: Option<i64>,
    updated_at: String,
}

/// What pausing or activating a schedule sets (`toUpdate(…, {enabled})`): its time checked again as it's stored, and its
/// next run, worked out again when it's turned on.
struct Toggled {
    cron: Option<String>,
    at: Option<String>,
    on: Option<String>,
    on_filter: Option<String>,
    timezone: String,
    enabled: bool,
    next_run: Option<String>,
}

/// A schedule `row` paused or activated, checked as `toUpdate` checks a change of `enabled` alone, or why it can't be.
fn toggled(row: &AnyRow, enabled: bool) -> std::result::Result<Toggled, String> {
    let text = |key: &str| row.get::<Option<String>, _>(key);
    let when = when(text("cron").as_deref(), text("at").as_deref(), text("on_event").as_deref(), text("timezone").as_deref(), false)?;
    let kind = row.get::<String, _>("kind");
    let notes = text("notes");
    let presets = row.get::<String, _>("presets");
    let untrusted = row.get::<i64, _>("untrusted") != 0;
    // `checkKind`, for the owner: a session or action schedule is theirs to keep.
    if kind == "message" && notes.as_deref().map_or(true, |n| n.trim().is_empty()) && presets == "[]" {
        return Err("A message schedule needs its message in \"notes\", or a preset in \"presets\"".into());
    }
    if kind == "action" && when.on.is_none() {
        return Err("An action schedule moves what an event is about: send \"on\", not \"cron\" or \"at\"".into());
    }
    if untrusted && kind != "message" {
        return Err("Only a message schedule is untrusted: send \"kind\": \"message\", or \"untrusted\": false".into());
    }
    // `filterOf`: an event schedule's filter, none on a clock's.
    let on_filter = text("on_filter").filter(|f| when.on.is_some() && f != "{}");
    let was_on = row.get::<i64, _>("enabled") != 0;
    let next_run = if !enabled {
        None
    } else if !was_on || text("next_run").is_none() {
        next_run(&when, chrono::Utc::now())
    } else {
        text("next_run")
    };
    Ok(Toggled { cron: when.cron, at: when.at, on: when.on, on_filter, timezone: when.timezone, enabled, next_run })
}

/// The 403 for anyone but the owner, as `ownerOnly(actor, 'schedules.enabled')` words it.
fn enabled_refused(actor: &Actor) -> ApiError {
    let action = "Pause or activate all of a project\u{2019}s schedules";
    let why = "Activating all also turns on what was paused on purpose, so it\u{2019}s the owner\u{2019}s to do, on Schedules.";
    let message = if actor.untrusted {
        format!("{action}: refused for an untrusted session (schedules.enabled). {why}")
    } else {
        format!("{action}: owner only for a session (schedules.enabled). {why} Send Orrery-Actor: <owner>")
    };
    ApiError::refused_for("schedules.enabled", message)
}

impl<'c> Schedules<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Schedules { conn, effects: Effects::default(), outbox: None }
    }

    /// The schedule's row as a write needs it (`row`), or a 404.
    async fn held(&mut self, project: &str, id: i64) -> Result<Held> {
        let row = sqlx::query(&sql(
            "SELECT CAST(owned AS BIGINT) AS owned, CAST(across AS BIGINT) AS across, updated_at FROM schedules WHERE project = ? AND id = ?",
        ))
        .bind(project)
        .bind(id)
        .fetch_optional(&mut *self.conn)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("No schedule {id} in {project}")))?;
        Ok(Held { owned: row.get::<i64, _>("owned") != 0, across: row.get::<Option<i64>, _>("across").filter(|a| *a != 0), updated_at: row.get("updated_at") })
    }

    /// The owner making an agent's schedule theirs ("Make it mine", ORR-456, `adopt`): from then on it runs as them,
    /// and only they change it. `seen` is the `updated_at` they read it at: one changed since is a 409, so they never
    /// take on words they haven't seen. One theirs already comes back as it is.
    pub async fn adopt(&mut self, project: &str, sent: &str, uid: &str, actor: &Actor, seen: Option<&str>) -> Result<Value> {
        let id = server_id("sch-", "schedule", sent, uid)?;
        if !actor.owner {
            return Err(ApiError::refused_for(
                "schedules.adopt",
                format!("Making schedule {id} yours: only the owner takes a schedule on; send Orrery-Actor: <owner>"),
            ));
        }
        let row = self.held(project, id).await?;
        if row.owned {
            return self.get(project, sent, uid).await;
        }
        if seen.is_some_and(|seen| seen != row.updated_at) {
            return Err(ApiError::conflict(format!("Schedule {id} changed after you read it: read it again, then make it yours")));
        }
        self.effects.schedules.push(project.into());
        changes::begin(self.conn).await?;
        let done = sqlx::query(&sql("UPDATE schedules SET owned = 1, created_by = ?, updated_at = ? WHERE id = ? AND updated_at = ?"))
            .bind(&actor.name)
            .bind(stamp())
            .bind(id)
            .bind(&row.updated_at)
            .execute(&mut *self.conn)
            .await
            .map(|_| ())
            .map_err(Into::into);
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let now = self.get(project, sent, uid).await?;
        if now["protected"] != json!(true) {
            return Err(ApiError::conflict(format!("Schedule {id} changed as you made it yours: read it again, then make it yours")));
        }
        Ok(now)
    }

    /// Deletes the schedule (`delete`): the owner's only by the owner. Its issues stay, no longer its. One made from a
    /// schedule across projects leaves that project out of it, and the last one out takes it with it (`leaveOut`).
    pub async fn delete(&mut self, project: &str, sent: &str, uid: &str, actor: &Actor) -> Result<()> {
        let id = server_id("sch-", "schedule", sent, uid)?;
        let row = self.held(project, id).await?;
        if row.owned && !actor.owner {
            return Err(ApiError::refused_for("schedules.owners", format!("Deleting schedule {id}: it's the owner's; only they can delete it")));
        }
        self.effects.schedules.push(project.into());
        changes::begin(self.conn).await?;
        let done = self.remove(project, id, row.across).await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// The owner pausing or activating all of a project's schedules at once (`setAllEnabled`, ORR-783): its copies of ones
    /// across projects too, but not those themselves. Activating leaves a paused one-off, which may have run. One that
    /// can't change (its stored time no longer checks out) is said in `failed` and doesn't stop the rest, and the project's
    /// schedules are said to have changed once. A project with none, or that isn't there, changes nothing.
    pub async fn set_all_enabled(&mut self, project: &str, enabled: bool, uid: &str, actor: &Actor) -> Result<Value> {
        if !actor.owner {
            return Err(enabled_refused(actor));
        }
        let rows =
            sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM schedules WHERE project = ? ORDER BY id"))).bind(project).fetch_all(&mut *self.conn).await?;
        // `canActivate`: only one that's paused and isn't a one-off; pausing, any that's on.
        let on = |row: &AnyRow| row.get::<i64, _>("enabled") != 0;
        let changing: Vec<&AnyRow> =
            rows.iter().filter(|row| if enabled { !on(row) && row.get::<Option<String>, _>("at").is_none() } else { on(row) }).collect();
        let mut sets = vec![];
        let mut failed = vec![];
        for row in &changing {
            let id: i64 = row.get("id");
            match toggled(row, enabled) {
                Ok(set) => sets.push((id, set)),
                Err(message) => failed.push(json!({"id": id, "title": row.get::<String, _>("title"), "message": message})),
            }
        }
        if changing.is_empty() {
            return Ok(json!({"changed": [], "failed": failed}));
        }
        self.effects.schedules.push(project.into());
        changes::begin(self.conn).await?;
        let done = self.write_toggled(&sets).await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let mut changed = vec![];
        for (id, _) in &sets {
            changed.push(self.get(project, &id.to_string(), uid).await?);
        }
        Ok(json!({"changed": changed, "failed": failed}))
    }

    async fn write_toggled(&mut self, sets: &[(i64, Toggled)]) -> Result<()> {
        let now = stamp();
        for (id, set) in sets {
            sqlx::query(&sql(
                "UPDATE schedules SET cron = ?, at = ?, on_event = ?, on_filter = ?, timezone = ?, enabled = ?, next_run = ?, updated_at = ? WHERE id = ?",
            ))
            .bind(&set.cron)
            .bind(&set.at)
            .bind(&set.on)
            .bind(&set.on_filter)
            .bind(&set.timezone)
            .bind(i64::from(set.enabled))
            .bind(&set.next_run)
            .bind(&now)
            .bind(id)
            .execute(&mut *self.conn)
            .await?;
        }
        Ok(())
    }

    async fn remove(&mut self, project: &str, id: i64, across: Option<i64>) -> Result<()> {
        if let Some(across) = across {
            self.leave_out(across, project).await?;
        }
        sqlx::query(&sql("DELETE FROM schedules WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
        sqlx::query(&sql("UPDATE issues SET schedule = NULL WHERE schedule = ?")).bind(id).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// Leaves `project` out of schedule across projects `id` (`leaveOut`): one for every project skips it from then on;
    /// one naming projects names it no more, and with none left it's gone.
    async fn leave_out(&mut self, id: i64, project: &str) -> Result<()> {
        let Some(row) = sqlx::query(&sql("SELECT projects, skip FROM schedules_across WHERE id = ?")).bind(id).fetch_optional(&mut *self.conn).await? else {
            return Err(ApiError::not_found(format!("No schedule across projects {id}")));
        };
        let list = |text: String| serde_json::from_str::<Vec<String>>(&text).unwrap_or_default();
        let projects: String = row.get("projects");
        let now = stamp();
        if projects == "*" {
            let mut skip = list(row.get("skip"));
            if !skip.iter().any(|p| p == project) {
                skip.push(project.into());
            }
            sqlx::query(&sql("UPDATE schedules_across SET skip = ?, updated_at = ? WHERE id = ?"))
                .bind(json!(skip).to_string())
                .bind(now)
                .bind(id)
                .execute(&mut *self.conn)
                .await?;
            return Ok(());
        }
        let left: Vec<String> = list(projects).into_iter().filter(|p| p != project).collect();
        if left.is_empty() {
            sqlx::query(&sql("UPDATE schedules SET across = NULL WHERE across = ?")).bind(id).execute(&mut *self.conn).await?;
            sqlx::query(&sql("DELETE FROM schedules_across WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
        } else {
            sqlx::query(&sql("UPDATE schedules_across SET projects = ?, updated_at = ? WHERE id = ?"))
                .bind(json!(left).to_string())
                .bind(now)
                .bind(id)
                .execute(&mut *self.conn)
                .await?;
        }
        Ok(())
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
