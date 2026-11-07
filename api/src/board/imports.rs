// Importing a roadmap into a project (ORR-1006): `POST /api/projects/{project}/import`, as `checkRoadmap`
// (web/server/utils/roadmap.ts), `importRoadmap` (web/server/store/imports.ts) and `renumber` (web/server/utils/renumber.ts)
// do it. The file is in `docs/roadmap.json`'s format: milestones of tasks with a status and a plan. Everything gets the
// project's ids (milestones 1, 2, …, issues KEY-1, …), the file's ids becoming aliases.
use crate::board::issue_edits::resolve_status;
use crate::board::issue_writes::IssueWrites;
use crate::board::issues::Issues;
use crate::changes;
use crate::db::{on_postgres, sql};
use crate::error::{ApiError, Result};
use crate::write::{stamp, Actor};
use regex::Regex;
use serde_json::{Map, Value};
use sqlx::{AnyConnection, Row};
use std::collections::{HashMap, HashSet};

const ROADMAP_FIELDS: [&str; 2] = ["$comment", "milestones"];
const MILESTONE_FIELDS: [&str; 4] = ["id", "title", "summary", "tasks"];
const TASK_FIELDS: [&str; 9] = ["id", "title", "priority", "assignee", "labels", "status", "plan", "notes", "tasks"];
const PRIORITIES: [&str; 4] = ["P0", "P1", "P2", "P3"];
const LEGACY_STATUSES: [&str; 3] = ["todo", "doing", "done"];
const LEGACY_PLANS: [&str; 3] = ["now", "next", "later"];

/// A roadmap, once checked (`RoadmapFile`).
#[derive(Debug, Default)]
pub struct Roadmap {
    pub milestones: Vec<MilestoneFile>,
}

#[derive(Debug, Default)]
pub struct MilestoneFile {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub tasks: Vec<TaskFile>,
}

#[derive(Debug, Default)]
pub struct TaskFile {
    pub id: String,
    pub title: String,
    pub priority: Option<String>,
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    pub status: String,
    pub plan: Option<String>,
    pub notes: Option<String>,
    pub tasks: Vec<TaskFile>,
}

/// A value as `describe` names it in a problem.
fn describe(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Array(_) => "a list".into(),
        Value::Object(_) => "an object".into(),
        Value::Bool(_) => format!("boolean {value}"),
        Value::Number(_) => format!("number {value}"),
        Value::String(_) => format!("string {value}"),
    }
}

/// Checks a roadmap as `checkRoadmap` does: unknown fields are refused, so typos show up, and each problem is a line
/// (where, then what) in the 400's `problems`.
pub fn check_roadmap(data: &Value) -> Result<Roadmap> {
    let Some(file) = data.as_object() else {
        return Err(roadmap_error("Not a roadmap", vec![format!("the file: should be an object with \"milestones\", not {}", describe(data))]));
    };
    let mut check = Check::default();
    check.fields(file, &ROADMAP_FIELDS, "the file");
    if !file.get("milestones").is_some_and(Value::is_array) {
        check.problem("the file", "missing \"milestones\"");
    }
    let milestones: Vec<MilestoneFile> =
        check.list(file, "milestones", "the file").iter().enumerate().filter_map(|(i, m)| check.milestone(m, &format!("milestones[{i}]"))).collect();
    check.text(file, "$comment", "the file", false);
    let count = check.problems.len();
    if count > 0 {
        let message = if count == 1 { "1 problem in the roadmap".to_string() } else { format!("{count} problems in the roadmap") };
        return Err(roadmap_error(&message, check.problems));
    }
    Ok(Roadmap { milestones })
}

/// The 400 for a file that isn't a roadmap: its message, and each problem (`badRequest(message, details)`).
fn roadmap_error(message: &str, problems: Vec<String>) -> ApiError {
    let mut error = ApiError::bad_request(message);
    error.data = Some(serde_json::json!({"problems": problems}));
    error
}

#[derive(Default)]
struct Check {
    problems: Vec<String>,
    issue_ids: HashSet<String>,
    milestone_ids: HashSet<String>,
}

impl Check {
    fn problem(&mut self, at: &str, what: &str) {
        self.problems.push(format!("{at}: {what}"));
    }

    fn fields(&mut self, value: &Map<String, Value>, known: &[&str], at: &str) {
        for key in value.keys() {
            if !known.contains(&key.as_str()) {
                self.problem(at, &format!("unknown field \"{key}\""));
            }
        }
    }

    fn text(&mut self, value: &Map<String, Value>, key: &str, at: &str, required: bool) -> Option<String> {
        match value.get(key) {
            None => {
                if required {
                    self.problem(at, &format!("missing \"{key}\""));
                }
                None
            }
            Some(Value::String(text)) => Some(text.clone()),
            Some(other) => {
                self.problem(at, &format!("\"{key}\" should be text, not {}", describe(other)));
                None
            }
        }
    }

    fn one_of(&mut self, value: &Map<String, Value>, key: &str, allowed: &[&str], at: &str) -> Option<String> {
        let found = self.text(value, key, at, false)?;
        if allowed.contains(&found.as_str()) {
            return Some(found);
        }
        self.problem(at, &format!("\"{key}\" is \"{found}\", not one of {}", allowed.join(", ")));
        None
    }

    fn list(&mut self, value: &Map<String, Value>, key: &str, at: &str) -> Vec<Value> {
        match value.get(key) {
            None => vec![],
            Some(Value::Array(items)) => items.clone(),
            Some(other) => {
                self.problem(at, &format!("\"{key}\" should be a list, not {}", describe(other)));
                vec![]
            }
        }
    }

    fn labels(&mut self, value: &Map<String, Value>, at: &str) -> Vec<String> {
        let found = self.list(value, "labels", at);
        if found.iter().all(Value::is_string) {
            return found.iter().filter_map(|l| l.as_str().map(str::to_string)).collect();
        }
        self.problem(at, "\"labels\" should be a list of strings");
        vec![]
    }

    fn task(&mut self, value: &Value, where_: &str) -> Option<TaskFile> {
        let Some(value) = value.as_object() else {
            self.problem(where_, &format!("should be an issue, not {}", describe(value)));
            return None;
        };
        let id = self.text(value, "id", where_, true).filter(|id| !id.is_empty());
        let at = id.clone().unwrap_or_else(|| where_.to_string());
        if let Some(id) = &id {
            if !self.issue_ids.insert(id.clone()) {
                self.problem(&at, "id is used by more than one issue");
            }
        }
        self.fields(value, &TASK_FIELDS, &at);
        let tasks: Vec<TaskFile> = self.list(value, "tasks", &at).iter().enumerate().filter_map(|(i, t)| self.task(t, &format!("{at} › tasks[{i}]"))).collect();
        Some(TaskFile {
            id: id.unwrap_or_default(),
            title: self.text(value, "title", &at, true).unwrap_or_default(),
            priority: self.one_of(value, "priority", &PRIORITIES, &at),
            assignee: self.text(value, "assignee", &at, false),
            labels: self.labels(value, &at),
            status: self.one_of(value, "status", &LEGACY_STATUSES, &at).unwrap_or_else(|| "todo".into()),
            plan: self.one_of(value, "plan", &LEGACY_PLANS, &at),
            notes: self.text(value, "notes", &at, false),
            tasks,
        })
    }

    fn milestone(&mut self, value: &Value, where_: &str) -> Option<MilestoneFile> {
        let Some(value) = value.as_object() else {
            self.problem(where_, &format!("should be a milestone, not {}", describe(value)));
            return None;
        };
        let id = self.text(value, "id", where_, true).filter(|id| !id.is_empty());
        let at = id.as_ref().map(|id| format!("milestone \"{id}\"")).unwrap_or_else(|| where_.to_string());
        if let Some(id) = &id {
            if !self.milestone_ids.insert(id.clone()) {
                self.problem(&at, "id is used by more than one milestone");
            }
        }
        self.fields(value, &MILESTONE_FIELDS, &at);
        if !value.get("tasks").is_some_and(Value::is_array) {
            self.problem(&at, "missing \"tasks\"");
        }
        let tasks: Vec<TaskFile> = self.list(value, "tasks", &at).iter().enumerate().filter_map(|(i, t)| self.task(t, &format!("{at} › tasks[{i}]"))).collect();
        Some(MilestoneFile {
            id: id.unwrap_or_default(),
            title: self.text(value, "title", &at, true).unwrap_or_default(),
            summary: self.text(value, "summary", &at, false).unwrap_or_default(),
            tasks,
        })
    }
}

/// The kind a task in the `roadmap.json` format becomes (`legacyStatus`): done → Done, doing → In progress, todo → Todo
/// with a plan, Backlog without one.
fn legacy_kind(task: &TaskFile) -> &'static str {
    match task.status.as_str() {
        "done" => "done",
        "doing" => "started",
        _ if task.plan.is_some() => "todo",
        _ => "backlog",
    }
}

impl IssueWrites<'_> {
    /// Loads the roadmap into the project (`importRoadmap`); `replace` first clears its milestones and issues. Refused
    /// when it has some already and `replace` isn't sent, with more than one person here unless a person asks, and to
    /// an agent replacing what the owner made.
    pub async fn import_roadmap(&mut self, project: &str, roadmap: &Roadmap, replace: bool, actor: &Actor) -> Result<()> {
        self.project_uid(project).await?;
        if self.rails_for(actor).await?.is_some() {
            return Err(ApiError::conflict("With more than one person on this orrery, only a person imports a roadmap"));
        }
        if replace && !actor.owner {
            let owned = self.owned_in(project).await?;
            if !owned.is_empty() {
                let shown = if owned.len() > 4 { [owned[..3].to_vec(), vec![format!("{} more", owned.len() - 3)]].concat() } else { owned.clone() };
                let was = if owned.len() == 1 { "was" } else { "were" };
                return Err(ApiError::refused_for(
                    "issues.delete",
                    format!("Replacing {project}'s roadmap is the owner's call: {} {was} made by the owner", shown.join(", ")),
                ));
            }
        }
        let has = sqlx::query(&sql("SELECT 1 FROM issues WHERE project = ? UNION SELECT 1 FROM milestones WHERE project = ?"))
            .bind(project)
            .bind(project)
            .fetch_optional(&mut *self.conn)
            .await?;
        if has.is_some() && !replace {
            return Err(ApiError::conflict(format!("{project} already has milestones or issues; import with ?replace=true to replace them")));
        }
        let statuses = Issues::new(&mut *self.conn).statuses().await?;
        let now = stamp();
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(if on_postgres() { "SET CONSTRAINTS ALL DEFERRED" } else { "PRAGMA defer_foreign_keys = ON" }).execute(&mut *self.conn).await?;
            if replace {
                self.clear_roadmap(project).await?;
            }
            let mut position = 0i64;
            for (i, milestone) in roadmap.milestones.iter().enumerate() {
                sqlx::query(&sql(
                    "INSERT INTO milestones (project, id, title, summary, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ))
                .bind(project)
                .bind(&milestone.id)
                .bind(&milestone.title)
                .bind((!milestone.summary.is_empty()).then_some(milestone.summary.as_str()))
                .bind(i as i64)
                .bind(&actor.name)
                .bind(i64::from(actor.owner))
                .bind(&now)
                .bind(&now)
                .execute(&mut *self.conn)
                .await?;
                for task in &milestone.tasks {
                    self.insert_task(project, task, None, Some(&milestone.id), &mut position, &statuses, actor, &now).await?;
                }
            }
            renumber(self.conn, project).await?;
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Clears the project's milestones and issues, and what names them without a foreign key (`issuesMoved` to null),
    /// so no id from the file comes to mean what was there.
    async fn clear_roadmap(&mut self, project: &str) -> Result<()> {
        let gone: Vec<String> = sqlx::query_scalar(&sql("SELECT id FROM issues WHERE project = ?")).bind(project).fetch_all(&mut *self.conn).await?;
        for old in &gone {
            sqlx::query(&sql("DELETE FROM signals WHERE project = ? AND issue = ?")).bind(project).bind(old).execute(&mut *self.conn).await?;
            self.drop_blocker(project, old, &gone).await?;
            sqlx::query(&sql("DELETE FROM issue_links WHERE (project = ? AND issue = ?) OR (on_project = ? AND on_issue = ?)"))
                .bind(project)
                .bind(old)
                .bind(project)
                .bind(old)
                .execute(&mut *self.conn)
                .await?;
            sqlx::query(&sql("UPDATE schedule_runs SET issue = NULL WHERE issue = ? AND schedule IN (SELECT id FROM schedules WHERE project = ?)"))
                .bind(old)
                .bind(project)
                .execute(&mut *self.conn)
                .await?;
        }
        for statement in [
            "DELETE FROM signals WHERE project = ? AND milestone IS NOT NULL",
            "UPDATE schedules SET milestone = NULL WHERE project = ?",
            "DELETE FROM comments WHERE project = ?",
            "UPDATE issues SET parent = NULL, milestone = NULL WHERE project = ?",
            "DELETE FROM issues WHERE project = ?",
            "DELETE FROM milestones WHERE project = ?",
            "DELETE FROM issue_aliases WHERE project = ?",
            "DELETE FROM milestone_aliases WHERE project = ?",
        ] {
            sqlx::query(&sql(statement)).bind(project).execute(&mut *self.conn).await?;
        }
        sqlx::query(&sql("DELETE FROM issue_links WHERE project = ? OR on_project = ?")).bind(project).bind(project).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// The task and its sub-issues, in order: each one's `position` is the next.
    #[allow(clippy::too_many_arguments)]
    async fn insert_task(
        &mut self,
        project: &str,
        task: &TaskFile,
        parent: Option<&str>,
        milestone: Option<&str>,
        position: &mut i64,
        statuses: &[crate::board::issues::Status],
        actor: &Actor,
        now: &str,
    ) -> Result<()> {
        let status = resolve_status(statuses, Some(legacy_kind(task)), None)?;
        sqlx::query(&sql(
            "INSERT INTO issues (project, id, title, status, priority, assignee, labels, notes, parent, milestone, position, created_by, owned, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ))
        .bind(project)
        .bind(&task.id)
        .bind(&task.title)
        .bind(&status)
        .bind(task.priority.as_deref())
        .bind(task.assignee.as_deref())
        .bind(serde_json::to_string(&task.labels).unwrap_or_else(|_| "[]".into()))
        .bind(task.notes.as_deref())
        .bind(parent)
        .bind(milestone)
        .bind(*position)
        .bind(&actor.name)
        .bind(i64::from(actor.owner))
        .bind(now)
        .bind(now)
        .execute(&mut *self.conn)
        .await?;
        *position += 1;
        for sub in &task.tasks {
            Box::pin(self.insert_task(project, sub, Some(&task.id), None, position, statuses, actor, now)).await?;
        }
        Ok(())
    }

    /// What the owner made in the project that replacing its roadmap would take away (`ownedIn`, its project and docs
    /// left out): milestones, releases, issues and their comments.
    async fn owned_in(&mut self, project: &str) -> Result<Vec<String>> {
        let mut out = vec![];
        let milestones: Vec<String> =
            sqlx::query_scalar(&sql("SELECT id FROM milestones WHERE project = ? AND owned = 1")).bind(project).fetch_all(&mut *self.conn).await?;
        out.extend(milestones.into_iter().map(|id| format!("milestone \"{id}\"")));
        let releases: Vec<String> =
            sqlx::query_scalar(&sql("SELECT version FROM releases WHERE project = ? AND owned = 1")).bind(project).fetch_all(&mut *self.conn).await?;
        out.extend(releases.into_iter().map(|version| format!("release {version}")));
        let issues: Vec<String> = sqlx::query_scalar(&sql("SELECT id FROM issues WHERE project = ?")).bind(project).fetch_all(&mut *self.conn).await?;
        if !issues.is_empty() {
            out.extend(self.owned_under(project, &issues).await?);
        }
        Ok(out)
    }
}

// Renumbering (`renumber`): what doesn't have the project's form of id yet gets the next free number, in roadmap order
// (sub-issues right after their parent), and keeps its old id as an alias. Ids already in that form keep it, and the
// counters never go back. Run with foreign keys deferred: rows point at ids that are changing.

/// Marks ids mid-rename, so a new id never meets an old one in a primary key.
const MOVING: &str = "\u{1}";
const UPSERT_ISSUE_ALIAS: &str =
    "INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?) ON CONFLICT (project, alias) DO UPDATE SET issue = excluded.issue";
const UPSERT_MILESTONE_ALIAS: &str =
    "INSERT INTO milestone_aliases (project, alias, milestone) VALUES (?, ?, ?) ON CONFLICT (project, alias) DO UPDATE SET milestone = excluded.milestone";

/// An issue as renumbering reads it: its id, parent and milestone.
type Row3 = (String, Option<String>, Option<String>);
/// The issues under each parent (`None`: the top).
type Children<'a> = HashMap<Option<String>, Vec<&'a Row3>>;

async fn renumber(conn: &mut AnyConnection, project: &str) -> Result<()> {
    let row = sqlx::query(&sql("SELECT key, next_number, next_milestone FROM projects WHERE id = ?")).bind(project).fetch_one(&mut *conn).await?;
    let key: String = row.get("key");
    let next_number: i64 = row.get("next_number");
    let next_milestone: i64 = row.get("next_milestone");
    let milestones: Vec<String> =
        sqlx::query_scalar(&sql("SELECT id FROM milestones WHERE project = ? ORDER BY position, created_at")).bind(project).fetch_all(&mut *conn).await?;
    let issues: Vec<Row3> = sqlx::query(&sql("SELECT id, parent, milestone FROM issues WHERE project = ? ORDER BY position, created_at"))
        .bind(project)
        .fetch_all(&mut *conn)
        .await?
        .iter()
        .map(|r| (r.get("id"), r.get("parent"), r.get("milestone")))
        .collect();

    let mut children: Children = HashMap::new();
    for issue in &issues {
        children.entry(issue.1.clone()).or_default().push(issue);
    }
    fn walk(id: &str, children: &Children, order: &mut Vec<String>) {
        order.push(id.to_string());
        for child in children.get(&Some(id.to_string())).into_iter().flatten() {
            walk(&child.0, children, order);
        }
    }
    let mut order = vec![];
    let top = children.get(&None).cloned().unwrap_or_default();
    for milestone in milestones.iter().map(|m| Some(m.clone())).chain([None]) {
        for issue in top.iter().filter(|t| t.2 == milestone) {
            walk(&issue.0, &children, &mut order);
        }
    }

    let own_milestone = Regex::new(r"^(\d+)$").unwrap();
    let own = Regex::new(&format!(r"^{}-(\d+)$", regex::escape(&key))).unwrap();
    let milestone_ids = numbered(&milestones, &own_milestone, |n| n.to_string(), next_milestone);
    let issue_ids = numbered(&order, &own, |n| format!("{key}-{n}"), next_number);

    let run = |statement: &'static str| sql(statement);
    let mut statements: Vec<(String, Vec<String>)> = vec![];
    let mut push = |statement: &'static str, params: &[&str]| statements.push((run(statement), params.iter().map(|p| p.to_string()).collect()));
    for (from, to) in &milestone_ids {
        let moving = format!("{MOVING}{to}");
        push("UPDATE milestones SET id = ? WHERE project = ? AND id = ?", &[&moving, project, from]);
        push("UPDATE issues SET milestone = ? WHERE project = ? AND milestone = ?", &[&moving, project, from]);
        push("UPDATE milestone_aliases SET milestone = ? WHERE project = ? AND milestone = ?", &[&moving, project, from]);
    }
    for (from, to) in &issue_ids {
        let moving = format!("{MOVING}{to}");
        push("UPDATE issues SET id = ? WHERE project = ? AND id = ?", &[&moving, project, from]);
        push("UPDATE issues SET parent = ? WHERE project = ? AND parent = ?", &[&moving, project, from]);
        push("UPDATE comments SET issue = ? WHERE project = ? AND issue = ?", &[&moving, project, from]);
        push("UPDATE issue_aliases SET issue = ? WHERE project = ? AND issue = ?", &[&moving, project, from]);
        push("UPDATE issue_links SET issue = ? WHERE project = ? AND issue = ?", &[&moving, project, from]);
        push("UPDATE issue_links SET on_issue = ? WHERE on_project = ? AND on_issue = ?", &[&moving, project, from]);
    }
    push("UPDATE milestones SET id = substr(id, 2) WHERE project = ? AND substr(id, 1, 1) = ?", &[project, MOVING]);
    push("UPDATE issues SET milestone = substr(milestone, 2) WHERE project = ? AND substr(milestone, 1, 1) = ?", &[project, MOVING]);
    push("UPDATE milestone_aliases SET milestone = substr(milestone, 2) WHERE project = ? AND substr(milestone, 1, 1) = ?", &[project, MOVING]);
    push("UPDATE issues SET id = substr(id, 2) WHERE project = ? AND substr(id, 1, 1) = ?", &[project, MOVING]);
    push("UPDATE issues SET parent = substr(parent, 2) WHERE project = ? AND substr(parent, 1, 1) = ?", &[project, MOVING]);
    push("UPDATE comments SET issue = substr(issue, 2) WHERE project = ? AND substr(issue, 1, 1) = ?", &[project, MOVING]);
    push("UPDATE issue_aliases SET issue = substr(issue, 2) WHERE project = ? AND substr(issue, 1, 1) = ?", &[project, MOVING]);
    push("UPDATE issue_links SET issue = substr(issue, 2) WHERE project = ? AND substr(issue, 1, 1) = ?", &[project, MOVING]);
    push("UPDATE issue_links SET on_issue = substr(on_issue, 2) WHERE on_project = ? AND substr(on_issue, 1, 1) = ?", &[project, MOVING]);
    for (from, to) in milestone_ids.iter().filter(|(from, to)| from != to) {
        push(UPSERT_MILESTONE_ALIAS, &[project, from, to]);
    }
    for (from, to) in issue_ids.iter().filter(|(from, to)| from != to) {
        push(UPSERT_ISSUE_ALIAS, &[project, from, to]);
    }
    // An alias that is now some thing's own id would only mislead.
    push("DELETE FROM milestone_aliases WHERE project = ? AND alias IN (SELECT id FROM milestones WHERE project = ?)", &[project, project]);
    push("DELETE FROM issue_aliases WHERE project = ? AND alias IN (SELECT id FROM issues WHERE project = ?)", &[project, project]);
    for (statement, params) in &statements {
        let mut query = sqlx::query(statement);
        for param in params {
            query = query.bind(param);
        }
        query.execute(&mut *conn).await?;
    }
    let issues_next = after(issue_ids.iter().map(|(_, to)| to.as_str()), &own, next_number);
    let milestones_next = after(milestone_ids.iter().map(|(_, to)| to.as_str()), &own_milestone, next_milestone);
    sqlx::query(&sql("UPDATE projects SET next_number = ?, next_milestone = ? WHERE id = ?"))
        .bind(issues_next)
        .bind(milestones_next)
        .bind(project)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Keeps the ids already in `form` and gives the rest the next numbers, from `next` or past the highest (`numbered`).
fn numbered(ids: &[String], form: &Regex, name: impl Fn(i64) -> String, next: i64) -> Vec<(String, String)> {
    let mut next = after(ids.iter().map(String::as_str), form, next);
    ids.iter()
        .map(|id| {
            if form.is_match(id) {
                (id.clone(), id.clone())
            } else {
                let to = name(next);
                next += 1;
                (id.clone(), to)
            }
        })
        .collect()
}

/// The number after the highest of `ids` in `form`, or `next` if that's further on (`after`).
fn after<'a>(ids: impl Iterator<Item = &'a str>, form: &Regex, next: i64) -> i64 {
    ids.map(|id| form.captures(id).and_then(|c| c[1].parse::<i64>().ok()).unwrap_or(0) + 1).fold(next, i64::max)
}
