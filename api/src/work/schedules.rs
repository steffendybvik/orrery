// The schedules (ORR-930, ORR-950): what `list`, `get` and `listAcross` in web/server/utils/schedules.ts do, answering
// as their `GET` routes do; and of its writes, the owner making one theirs (`adopt`), deleting one (`delete`), and
// pausing or activating all of a project's at once (`set_all_enabled`, ORR-1082), and making and changing one (`create`,
// `update`), and deleting one across projects (`delete_across`). Each write says the project's schedules changed
// (`Effects::schedules`), so the local app's scheduler reads them again. Running them, the requests on comments, and
// making and changing one across projects (`create_across`, `update_across`, ORR-1036) are here too.
use crate::board::issue_edits::resolve_status;
use crate::board::issues::Issues;
use crate::board::milestones::Milestones;
use crate::board::statuses::Statuses;
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::work::presets::{server_id, Presets};
use crate::work::schedule_input::check_input;
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
    /// Checks a write as it would be made and stops before saving it (`check`).
    dry: bool,
    /// The schedule across projects a schedule `create` makes is a copy of (`across`).
    across: Option<i64>,
    /// A change that comes from the schedule across projects a schedule is made from, which may change more of it than
    /// pausing it (`asAcross`).
    as_across: bool,
    /// The workspace whose schedules across projects these are (ORR-1107): one for every project is for every project
    /// of it alone.
    pub workspace: String,
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

/// The statuses' kinds, which `move_from` may name instead of a status.
const STATUS_KINDS: [&str; 5] = ["backlog", "todo", "started", "done", "canceled"];

/// What each kind needs (`checkKind`): a message has words, its own or a preset's; a session is the owner's to start, as
/// it works as them; an action is too, and needs an event to move what it's about; only a message is untrusted.
fn check_kind(kind: &str, notes: Option<&str>, presets: &str, untrusted: bool, actor: &Actor, on: Option<&str>) -> Result<()> {
    if kind == "message" && notes.map_or(true, |n| n.trim().is_empty()) && presets == "[]" {
        return Err(ApiError::bad_request("A message schedule needs its message in \"notes\", or a preset in \"presets\""));
    }
    if kind == "session" && !actor.owner {
        return Err(ApiError::refused_for("schedules.session", "Only the owner makes a session schedule: it starts work as them; send Orrery-Actor: <owner>"));
    }
    if kind == "action" && !actor.owner {
        return Err(ApiError::refused_for("schedules.action", "Only the owner makes an action schedule: it moves issues as them; send Orrery-Actor: <owner>"));
    }
    if kind == "action" && on.is_none() {
        return Err(ApiError::bad_request("An action schedule moves what an event is about: send \"on\", not \"cron\" or \"at\""));
    }
    if untrusted && kind != "message" {
        return Err(ApiError::bad_request("Only a message schedule is untrusted: send \"kind\": \"message\", or \"untrusted\": false"));
    }
    Ok(())
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

/// Which projects a schedule across projects is for: every one (`*`), or those named.
enum Projects {
    Every,
    Named(Vec<String>),
}

/// How `schedules_across.projects` keeps them: `*`, or the ids as JSON.
fn projects_text(projects: &Projects) -> String {
    match projects {
        Projects::Every => "*".into(),
        Projects::Named(named) => json!(named).to_string(),
    }
}

fn string_list(value: &Value) -> Vec<String> {
    value.as_array().map(|all| all.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Whether a field is sent as something JavaScript counts as set (not null, false, 0 or "").
fn is_set(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null) | Some(Value::Bool(false))) && value != Some(&json!(0)) && value != Some(&json!(""))
}

/// What's sent for a schedule across projects (`acrossInput`): its projects, those skipped, and a schedule's fields, less
/// what can't be the same on every project.
/// What `across_input` reads: the projects, those skipped, and the schedule's fields.
type AcrossInput = (Option<Projects>, Option<Vec<String>>, Map<String, Value>);

fn across_input(body: &Value) -> Result<AcrossInput> {
    let Some(sent) = body.as_object() else {
        return Err(ApiError::bad_request("Send an object: {\"projects\": \"*\", \"title\": \"Tidy\", \"on\": \"pr.merged\"}"));
    };
    let mut fields = sent.clone();
    let projects = fields.remove("projects");
    let skip = fields.remove("skip");
    let is_list = |v: &Value| v.as_array().is_some_and(|all| all.iter().all(Value::is_string));
    let projects = match projects {
        None => None,
        Some(Value::String(all)) if all == "*" => Some(Projects::Every),
        Some(list) if is_list(&list) && !string_list(&list).is_empty() => Some(Projects::Named(string_list(&list))),
        Some(_) => return Err(ApiError::bad_request("\"projects\" is \"*\", or a list of ids")),
    };
    let skip = match skip {
        None => None,
        Some(list) if is_list(&list) => Some(string_list(&list)),
        Some(_) => return Err(ApiError::bad_request("\"skip\" is a list of ids")),
    };
    if is_set(fields.get("milestone")) {
        return Err(ApiError::bad_request("A schedule across projects can't name a milestone: a milestone is one project's"));
    }
    if is_set(fields.get("at")) {
        return Err(ApiError::bad_request("A schedule across projects runs on a cron or an event, not once"));
    }
    if is_set(fields.get("untrusted")) {
        return Err(ApiError::bad_request("A schedule across projects can't be untrusted"));
    }
    Ok((projects, skip, fields))
}

/// The 403 for anyone but the owner, as `ownerOnly(actor, 'schedules.across')` words it.
fn across_refused(actor: &Actor) -> ApiError {
    let action = "Make, change or delete a schedule across projects";
    let why = "It runs as the owner on every project it names, and on ones added later.";
    let message = if actor.untrusted {
        format!("{action}: refused for an untrusted session (schedules.across). {why}")
    } else {
        format!("{action}: owner only for a session (schedules.across). {why} Send Orrery-Actor: <owner>")
    };
    ApiError::refused_for("schedules.across", message)
}

impl<'c> Schedules<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Schedules { conn, effects: Effects::default(), outbox: None, dry: false, across: None, as_across: false, workspace: "default".into() }
    }

    /// The same, for the schedules across projects of `workspace` (ORR-1107).
    pub fn within(self, workspace: String) -> Self {
        Schedules { workspace, ..self }
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

    /// Changes the schedule (`update`, `toUpdate`): checked as Schedules checks it, the owner's only by the owner, and one
    /// made from a schedule across projects only paused or resumed here. Changing when it runs, or turning it back on,
    /// works out its next run again; setting one of cron, at and on lets go of the others.
    pub async fn update(&mut self, project: &str, sent: &str, body: &Value, uid: &str, actor: &Actor) -> Result<Value> {
        let id = server_id("sch-", "schedule", sent, uid)?;
        let row = sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM schedules WHERE project = ? AND id = ?")))
            .bind(project)
            .bind(id)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No schedule {id} in {project}")))?;
        let text = |key: &str| row.get::<Option<String>, _>(key);
        let flag = |key: &str| row.get::<i64, _>(key) != 0;
        if flag("owned") && !actor.owner {
            return Err(ApiError::refused_for("schedules.owners", format!("Changing schedule {id}: it's the owner's; only they can change it")));
        }
        if let Some(across) = row.get::<Option<i64>, _>("across").filter(|a| *a != 0 && !self.as_across) {
            if body.as_object().is_some_and(|b| b.keys().any(|k| k != "enabled")) {
                return Err(ApiError::conflict(format!("Schedule {id} is made from schedule across projects {across}: change it there, or pause it here")));
            }
        }
        let input = check_input(body, true)?;
        let sent = |key: &str| input.get(key);
        let given = |key: &str| sent(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        let timing = ["cron", "at", "on", "timezone"].iter().any(|k| sent(k).is_some());
        // Setting one of cron, at and on lets go of the others.
        let pick = |key: &str, others: [&str; 2], column: &str| match sent(key) {
            Some(value) => value.as_str().map(String::from),
            None if others.iter().any(|o| given(o).is_some()) => None,
            None => text(column),
        };
        let cron = pick("cron", ["at", "on"], "cron");
        let at = pick("at", ["cron", "on"], "at");
        let on = pick("on", ["cron", "at"], "on_event");
        let timezone = sent("timezone").and_then(Value::as_str).map(String::from).or_else(|| text("timezone"));
        let when = when(cron.as_deref(), at.as_deref(), on.as_deref(), timezone.as_deref(), timing).map_err(ApiError::bad_request)?;
        // `filterOf`: an event schedule's filter, none on a clock's.
        let filter = match sent("on_filter") {
            Some(value) => value.as_str().map(String::from),
            None => text("on_filter"),
        };
        let on_filter = filter.filter(|f| when.on.is_some() && f != "{}");
        let enabled = sent("enabled").and_then(Value::as_bool).unwrap_or(flag("enabled"));
        let next = if !enabled {
            None
        } else if timing || !flag("enabled") || text("next_run").is_none() {
            next_run(&when, chrono::Utc::now())
        } else {
            text("next_run")
        };
        let was: String = row.get("kind");
        let kind = given("kind").map(String::from).unwrap_or_else(|| was.clone());
        let notes = match sent("notes") {
            Some(value) => value.as_str().filter(|n| !n.is_empty()).map(String::from),
            None => text("notes"),
        };
        let presets = if sent("presets").is_none() && kind == was {
            row.get::<String, _>("presets")
        } else if kind == "issue" || kind == "action" {
            "[]".into()
        } else {
            let ids = match sent("presets") {
                Some(value) => value.as_str().unwrap_or("[]").to_string(),
                None => row.get::<String, _>("presets"),
            };
            self.usable_presets(project, &ids).await?;
            ids
        };
        let untrusted = sent("untrusted").and_then(Value::as_bool).unwrap_or(flag("untrusted"));
        check_kind(&kind, notes.as_deref(), &presets, untrusted, actor, when.on.as_deref())?;
        if kind == "action" && was != "action" && sent("column").is_none() {
            return Err(ApiError::bad_request("An action schedule moves issues to a status: send it in \"column\""));
        }
        let mut set: Vec<(&str, Value)> = vec![];
        if let Some(kind) = sent("kind") {
            set.push(("kind", kind.clone()));
        }
        if let Some(title) = sent("title").and_then(Value::as_str) {
            set.push(("title", json!(title.trim())));
        }
        if sent("notes").is_some() {
            set.push(("notes", json!(notes)));
        }
        set.extend([
            ("cron", json!(when.cron)),
            ("at", json!(when.at)),
            ("on_event", json!(when.on)),
            ("on_filter", json!(on_filter)),
            ("presets", json!(presets)),
            ("timezone", json!(when.timezone)),
        ]);
        // A status an action schedule moved issues to may be closed, which is no place for another kind's issues to start.
        if let Some(column) = sent("column").and_then(Value::as_str) {
            set.push(("place", json!(self.place(column, &kind).await?)));
        } else if kind != was {
            let place: String = row.get("place");
            set.push(("place", json!(self.place(&place, &kind).await?)));
        }
        if let Some(from) = sent("move_from") {
            set.push(("move_from", json!(self.move_from(from).await?)));
        }
        if let Some(milestone) = sent("milestone") {
            let id = match milestone.as_str().filter(|m| !m.is_empty()) {
                Some(m) => Some(Milestones::new(&mut *self.conn).milestone_id(project, m).await?.0),
                None => None,
            };
            set.push(("milestone", json!(id)));
        }
        if let Some(priority) = sent("priority") {
            set.push(("priority", json!(priority.as_str().filter(|p| !p.is_empty()))));
        }
        if let Some(labels) = sent("labels") {
            set.push(("labels", json!(if labels.is_null() { json!([]) } else { labels.clone() }.to_string())));
        }
        for key in ["ask", "skip_open", "only_if_changed", "untrusted"] {
            if let Some(on) = sent(key).and_then(Value::as_bool) {
                set.push((key, json!(i64::from(on))));
            }
        }
        for key in ["model", "effort"] {
            if let Some(value) = sent(key) {
                set.push((key, json!(value.as_str().filter(|v| !v.is_empty()))));
            }
        }
        set.extend([("enabled", json!(i64::from(enabled))), ("next_run", json!(next)), ("updated_at", json!(stamp()))]);
        if self.dry {
            return Ok(Value::Null);
        }
        self.effects.schedules.push(project.into());
        changes::begin(self.conn).await?;
        let done = self.write(id, &set).await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        self.get(project, &id.to_string(), uid).await
    }

    /// Checks a new schedule (`schedule` none) or a change to one as `create` and `update` would, saving nothing
    /// (`check`): so a session's request for one fails when it asks, not once the owner allows it.
    pub async fn check(&mut self, project: &str, schedule: Option<i64>, body: &Value, uid: &str, actor: &Actor) -> Result<()> {
        self.dry = true;
        let checked = match schedule {
            Some(id) => self.update(project, &id.to_string(), body, uid, actor).await,
            None => self.create(project, body, uid, actor).await,
        };
        self.dry = false;
        checked.map(|_| ())
    }

    /// Makes a schedule (`create`, `toCreate`), checked in the order Schedules checks it, with its next run worked out
    /// unless it's made paused. It's the maker's: the owner's only when the owner makes it.
    pub async fn create(&mut self, project: &str, body: &Value, uid: &str, actor: &Actor) -> Result<Value> {
        let found = sqlx::query(&sql("SELECT 1 FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await?;
        if found.is_none() {
            return Err(ApiError::not_found(format!("No project \"{project}\"")));
        }
        let input = check_input(body, false)?;
        let given = |key: &str| input.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        let when = when(given("cron"), given("at"), given("on"), given("timezone"), true).map_err(ApiError::bad_request)?;
        let milestone = match given("milestone") {
            Some(m) => Some(Milestones::new(&mut *self.conn).milestone_id(project, m).await?.0),
            None => None,
        };
        let enabled = input.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        let kind = given("kind").unwrap_or("issue").to_string();
        let presets = if kind == "issue" || kind == "action" {
            "[]".to_string()
        } else {
            let ids = given("presets").unwrap_or("[]").to_string();
            self.usable_presets(project, &ids).await?;
            ids
        };
        let notes = given("notes").map(String::from);
        let flag = |key: &str, or: bool| input.get(key).and_then(Value::as_bool).unwrap_or(or);
        check_kind(&kind, notes.as_deref(), &presets, flag("untrusted", false), actor, when.on.as_deref())?;
        if kind == "action" && input.get("column").is_none() {
            return Err(ApiError::bad_request("An action schedule moves issues to a status: send it in \"column\""));
        }
        let on_filter = given("on_filter").filter(|f| when.on.is_some() && *f != "{}").map(String::from);
        let move_from = self.move_from(input.get("move_from").unwrap_or(&Value::Null)).await?;
        let place = self.place(given("column").unwrap_or("todo"), &kind).await?;
        let labels = input.get("labels").filter(|l| !l.is_null()).cloned().unwrap_or_else(|| json!([])).to_string();
        let next = if enabled { next_run(&when, chrono::Utc::now()) } else { None };
        let title = input.get("title").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if self.dry {
            return Ok(Value::Null);
        }
        let now = stamp();
        let bit = |on: bool| i64::from(on);
        self.effects.schedules.push(project.into());
        changes::begin(self.conn).await?;
        let done: Result<i64> = async {
            let row = sqlx::query(&sql(
                "INSERT INTO schedules (project, kind, title, notes, cron, at, on_event, on_filter, presets, move_from, timezone, place, milestone, priority,
                    labels, ask, skip_open, only_if_changed, untrusted, enabled, next_run, created_by, owned, created_at, updated_at, model, effort, across)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS BIGINT) AS id",
            ))
            .bind(project)
            .bind(&kind)
            .bind(&title)
            .bind(&notes)
            .bind(&when.cron)
            .bind(&when.at)
            .bind(&when.on)
            .bind(&on_filter)
            .bind(&presets)
            .bind(&move_from)
            .bind(&when.timezone)
            .bind(&place)
            .bind(&milestone)
            .bind(given("priority"))
            .bind(&labels)
            .bind(bit(flag("ask", false)))
            .bind(bit(flag("skip_open", true)))
            .bind(bit(flag("only_if_changed", false)))
            .bind(bit(flag("untrusted", false)))
            .bind(bit(enabled))
            .bind(&next)
            .bind(&actor.name)
            .bind(bit(actor.owner))
            .bind(&now)
            .bind(&now)
            .bind(given("model"))
            .bind(given("effort"))
            .bind(self.across)
            .fetch_one(&mut *self.conn)
            .await?;
            Ok(row.get("id"))
        }
        .await;
        let id = changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        self.get(project, &id.to_string(), uid).await
    }

    /// Makes a schedule across projects (`createAcross`), `{projects: "*" | [ids], skip?, …a schedule's fields}`: the
    /// owner's alone, as it runs as them everywhere. Checked as each project's own would be, then made on each.
    pub async fn create_across(&mut self, body: &Value, uid: &str, actor: &Actor) -> Result<Value> {
        if !actor.owner {
            return Err(across_refused(actor));
        }
        let (projects, skip, fields) = across_input(body)?;
        let projects = projects.ok_or_else(|| ApiError::bad_request("Send \"projects\": \"*\" for all of them, or a list of ids"))?;
        let skip = skip.unwrap_or_default();
        let workspace = self.workspace.clone();
        let targets = self.across_targets(&workspace, &projects, &skip, false).await?;
        if targets.is_empty() {
            return Err(ApiError::bad_request("That leaves no project for it to run on"));
        }
        let fields = Value::Object(fields);
        for project in &targets {
            self.check(project, None, &fields, uid, actor).await?;
        }
        let now = stamp();
        changes::begin(self.conn).await?;
        let done: Result<i64> = async {
            let row = sqlx::query(&sql(
                "INSERT INTO schedules_across (projects, skip, body, created_by, created_at, updated_at, workspace) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS BIGINT) AS id",
            ))
            .bind(projects_text(&projects))
            .bind(json!(skip).to_string())
            .bind(fields.to_string())
            .bind(&actor.name)
            .bind(&now)
            .bind(&now)
            .bind(&workspace)
            .fetch_one(&mut *self.conn)
            .await?;
            Ok(row.get("id"))
        }
        .await;
        let id = changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        self.settle_across(uid).await?;
        self.across_one(id).await
    }

    /// Changes a schedule across projects and the schedules made from it, all checked first, and which projects it's for
    /// (`updateAcross`). What each has run stays.
    pub async fn update_across(&mut self, sent: &str, body: &Value, uid: &str, actor: &Actor) -> Result<Value> {
        if !actor.owner {
            return Err(across_refused(actor));
        }
        let missing = || ApiError::not_found(format!("No schedule across projects {}", sent.parse::<i64>().map_or("NaN".into(), |n| n.to_string())));
        let id = sent.parse::<i64>().map_err(|_| missing())?;
        let row = sqlx::query(&sql("SELECT projects, skip, body FROM schedules_across WHERE id = ? AND workspace = ?"))
            .bind(id)
            .bind(&self.workspace)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(missing)?;
        let (projects, skip, fields) = across_input(body)?;
        let mut merged = match parsed(&row.get::<String, _>("body")) {
            Value::Object(body) => body,
            _ => Map::new(),
        };
        merged.extend(fields.clone());
        // Setting one of cron and on lets go of the other, as a schedule's own change does.
        if is_set(fields.get("cron")) {
            merged.remove("on");
        }
        if is_set(fields.get("on")) {
            merged.remove("cron");
        }
        let stored: String = row.get("projects");
        let projects = projects.unwrap_or_else(|| if stored == "*" { Projects::Every } else { Projects::Named(string_list(&parsed(&stored))) });
        let skip = skip.unwrap_or_else(|| string_list(&parsed(&row.get::<String, _>("skip"))));
        let workspace = self.workspace.clone();
        let targets = self.across_targets(&workspace, &projects, &skip, false).await?;
        let copies = self.copies(id).await?;
        let fields = Value::Object(fields);
        let merged = Value::Object(merged);
        self.as_across = true;
        let checked: Result<()> = async {
            for (copy, project) in &copies {
                self.check(project, Some(*copy), &fields, uid, actor).await?;
            }
            for project in targets.iter().filter(|t| !copies.iter().any(|(_, p)| p == *t)) {
                self.check(project, None, &merged, uid, actor).await?;
            }
            changes::begin(self.conn).await?;
            let done = sqlx::query(&sql("UPDATE schedules_across SET projects = ?, skip = ?, body = ?, updated_at = ? WHERE id = ?"))
                .bind(projects_text(&projects))
                .bind(json!(skip).to_string())
                .bind(merged.to_string())
                .bind(stamp())
                .bind(id)
                .execute(&mut *self.conn)
                .await
                .map(|_| ())
                .map_err(Into::into);
            changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
            for (copy, project) in &copies {
                self.update(project, &copy.to_string(), &fields, uid, actor).await?;
            }
            Ok(())
        }
        .await;
        self.as_across = false;
        checked?;
        self.settle_across(uid).await?;
        self.across_one(id).await
    }

    /// Keeps each schedule across projects' copies to the projects it's for (`settleAcross`): makes the missing, as a
    /// project added since, and removes those no longer named. Goes on past one that can't be made (a preset gone), to
    /// try again next time.
    async fn settle_across(&mut self, uid: &str) -> Result<()> {
        let rows = sqlx::query("SELECT CAST(id AS BIGINT) AS id, projects, skip, body, created_by, workspace FROM schedules_across")
            .fetch_all(&mut *self.conn)
            .await?;
        for row in &rows {
            let id: i64 = row.get("id");
            let stored: String = row.get("projects");
            let projects = if stored == "*" { Projects::Every } else { Projects::Named(string_list(&parsed(&stored))) };
            let workspace: String = row.get("workspace");
            let targets = self.across_targets(&workspace, &projects, &string_list(&parsed(&row.get::<String, _>("skip"))), true).await?;
            let copies = self.copies(id).await?;
            for (copy, project) in copies.iter().filter(|(_, p)| !targets.contains(p)) {
                if !self.effects.schedules.contains(project) {
                    self.effects.schedules.push(project.clone());
                }
                changes::begin(self.conn).await?;
                let done = self.remove(project, *copy, None).await;
                changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
            }
            let body = parsed(&row.get::<String, _>("body"));
            let maker = Actor { name: row.get("created_by"), owner: true, ..Actor::default() };
            for project in targets.iter().filter(|t| !copies.iter().any(|(_, p)| p == *t)) {
                self.across = Some(id);
                let made = self.create(project, &body, uid, &maker).await;
                self.across = None;
                if let Err(error) = made {
                    eprintln!("[orrery] schedule across projects {id} on {project}: {error:?}");
                }
            }
        }
        Ok(())
    }

    /// The projects named, what opted out left out (`acrossTargets`), all in `workspace` (ORR-1107); one named that's
    /// gone, or in another workspace, is refused, or with `lenient` passed over.
    async fn across_targets(&mut self, workspace: &str, projects: &Projects, skip: &[String], lenient: bool) -> Result<Vec<String>> {
        let every: Vec<String> = sqlx::query(&sql("SELECT id FROM projects WHERE workspace = ? ORDER BY id"))
            .bind(workspace)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| r.get("id"))
            .collect();
        Ok(match projects {
            Projects::Every => every.into_iter().filter(|id| !skip.contains(id)).collect(),
            Projects::Named(named) => {
                if !lenient {
                    if let Some(gone) = named.iter().find(|id| !every.contains(id)) {
                        return Err(ApiError::not_found(format!("No project \"{gone}\"")));
                    }
                }
                named.iter().filter(|id| every.contains(id)).cloned().collect()
            }
        })
    }

    /// The schedules made from schedule across projects `id`, with their projects.
    async fn copies(&mut self, id: i64) -> Result<Vec<(i64, String)>> {
        Ok(sqlx::query(&sql("SELECT CAST(id AS BIGINT) AS id, project FROM schedules WHERE across = ? ORDER BY id"))
            .bind(id)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|row| (row.get("id"), row.get("project")))
            .collect())
    }

    /// One schedule across projects, as `across` lists it (`acrossOf`).
    async fn across_one(&mut self, id: i64) -> Result<Value> {
        let all = self.across().await?;
        all.as_array()
            .and_then(|all| all.iter().find(|a| a["id"] == id).cloned())
            .ok_or_else(|| ApiError::not_found(format!("No schedule across projects {id}")))
    }

    /// Deletes a schedule across projects and the schedules made from it (`deleteAcross`); their issues stay. The
    /// owner's alone, as it runs as them on every project.
    pub async fn delete_across(&mut self, sent: &str, actor: &Actor) -> Result<()> {
        if !actor.owner {
            return Err(across_refused(actor));
        }
        let missing = || ApiError::not_found(format!("No schedule across projects {}", sent.parse::<i64>().map_or("NaN".into(), |n| n.to_string())));
        let id = sent.parse::<i64>().map_err(|_| missing())?;
        if sqlx::query(&sql("SELECT 1 FROM schedules_across WHERE id = ? AND workspace = ?"))
            .bind(id)
            .bind(&self.workspace)
            .fetch_optional(&mut *self.conn)
            .await?
            .is_none()
        {
            return Err(missing());
        }
        let copies: Vec<(i64, String)> = sqlx::query(&sql("SELECT CAST(id AS BIGINT) AS id, project FROM schedules WHERE across = ? ORDER BY id"))
            .bind(id)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|row| (row.get("id"), row.get("project")))
            .collect();
        for (_, project) in &copies {
            if !self.effects.schedules.contains(project) {
                self.effects.schedules.push(project.clone());
            }
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            for (copy, project) in &copies {
                self.remove(project, *copy, None).await?;
            }
            sqlx::query(&sql("DELETE FROM schedules_across WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn write(&mut self, id: i64, set: &[(&str, Value)]) -> Result<()> {
        let columns: Vec<String> = set.iter().map(|(k, _)| format!("{k} = ?")).collect();
        let query = sql(&format!("UPDATE schedules SET {} WHERE id = ?", columns.join(", ")));
        let mut update = sqlx::query(&query);
        for (_, value) in set {
            update = match value {
                Value::Null => update.bind(None::<String>),
                Value::Number(n) => update.bind(n.as_i64()),
                Value::String(s) => update.bind(s.clone()),
                other => update.bind(other.to_string()),
            };
        }
        update.bind(id).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// The presets a message or session schedule is given (`presetsFor`): each one its project's sessions can have.
    async fn usable_presets(&mut self, project: &str, ids: &str) -> Result<()> {
        let ids: Vec<i64> = serde_json::from_str(ids).unwrap_or_default();
        let usable = Presets::new(&mut *self.conn).list(Some(project)).await?;
        let usable = usable.as_array().cloned().unwrap_or_default();
        let unknown: Vec<String> = ids.iter().filter(|id| !usable.iter().any(|p| p["id"] == json!(id))).map(i64::to_string).collect();
        if unknown.is_empty() {
            return Ok(());
        }
        let can: Vec<String> = usable.iter().map(|p| format!("{} ({})", p["id"], p["name"].as_str().unwrap_or_default())).collect();
        let can = if can.is_empty() { "none yet".to_string() } else { can.join(", ") };
        Err(ApiError::bad_request(format!("No preset {} for {project}; its sessions can have {can}", unknown.join(", "))))
    }

    /// The status a schedule's issues start in (`place`), from an id or a kind; an action schedule's may be closed, as
    /// it's where it moves them.
    async fn place(&mut self, column: &str, kind: &str) -> Result<String> {
        let statuses = Issues::new(&mut *self.conn).statuses().await?;
        let id = resolve_status(&statuses, Some(column), None)?;
        let status = self.status(&id).await?;
        if kind != "action" && ["done", "canceled"].contains(&status["kind"].as_str().unwrap_or_default()) {
            return Err(ApiError::bad_request(format!("A schedule's issues start open, not in {}", status["name"].as_str().unwrap_or_default())));
        }
        Ok(id)
    }

    /// `move_from` as it's stored: statuses' ids or kinds, each once.
    async fn move_from(&mut self, from: &Value) -> Result<String> {
        let from: Vec<String> = from.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect();
        for status in &from {
            if !STATUS_KINDS.contains(&status.as_str()) {
                self.status(status).await?;
            }
        }
        Ok(json!(from).to_string())
    }

    /// A status as the API gives it (`status`), or a 404.
    async fn status(&mut self, id: &str) -> Result<Value> {
        let statuses = Statuses::new(&mut *self.conn).list().await?;
        statuses.as_array().into_iter().flatten().find(|s| s["id"] == id).cloned().ok_or_else(|| ApiError::not_found(format!("No status \"{id}\"")))
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
        let rows = sqlx::query(&sql(
            "SELECT CAST(id AS BIGINT) AS id, projects, skip, body, created_by, created_at, updated_at FROM schedules_across WHERE workspace = ? ORDER BY id",
        ))
        .bind(&self.workspace)
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
#[path = "schedules_tests.rs"]
mod tests;
