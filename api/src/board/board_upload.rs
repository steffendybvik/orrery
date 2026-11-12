// A board's file brought in as a new board (ORR-670, moved in ORR-1142): the writing half of web/server/utils/
// board-upload.ts's `uploadBoard`. The local app checks the file first, as it's untrusted: its rows are brought up to
// this schema in a throwaway SQLite at the file's own step, which never touches the database (`checkedBoard`). What it
// sends here is those rows, with what the file says of its statuses, people and images, and the id, key and name the
// board is to have. This makes the board from them, all or nothing: every id numbered across the server is numbered
// again, and nothing in it speaks for anyone. Nothing is the owner's, its comments reach no session, its schedules are
// paused, and what would act on its own (prompts, a repo to poll, starting sessions, claims) is left behind.
use crate::board::uploads::{decode, type_of, UPLOAD_LIMIT};
use crate::changes;
use crate::db::{on_postgres, sql};
use crate::error::{ApiError, Result};
use crate::migrate::uid_of;
use crate::text::RESERVED_KEYS;
use crate::work::settings::hex;
use crate::write::{stamp, Actor, Effects};
use regex::Regex;
use serde_json::{Map, Value};
use sqlx::{AnyConnection, Row as _};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,39}$").unwrap());
static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9]{0,9}$").unwrap());
static UPLOAD_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{24}$").unwrap());
static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)$").unwrap());

type Row = Map<String, Value>;

/// The tables a board's file holds, as the local app sends them once they're checked (`EXPORTED`).
const TABLES: [&str; 18] = [
    "projects",
    "project_members",
    "releases",
    "milestones",
    "milestone_aliases",
    "issues",
    "issue_aliases",
    "issue_links",
    "issue_events",
    "comments",
    "milestone_comments",
    "schedule_requests",
    "docs",
    "doc_sections",
    "doc_revisions",
    "schedules",
    "schedule_runs",
    "presets",
];

fn rows(value: Option<&Value>) -> Vec<&Row> {
    value.and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_object).collect()).unwrap_or_default()
}

/// A value as JavaScript's `String()` says it, for the ids a file's rows point at each other with.
fn said(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        Value::Number(n) => whole(n).map(|n| n.to_string()).unwrap_or_else(|| n.to_string()),
        other => other.to_string(),
    }
}

/// A number that's whole, as an integer, however it was written.
fn whole(n: &serde_json::Number) -> Option<i64> {
    n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9e15).map(|f| f as i64))
}

/// `Number(value)` for the counters a project carries.
fn number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(text) => text.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => 0.0,
    }
}

/// The next number after the highest one in these ids, or `at` when that's further on: an id the file names is never
/// handed out again (`pastIds`).
fn past_ids<'a>(ids: impl Iterator<Item = &'a Value>, at: &Value) -> i64 {
    let at = number(at);
    let mut next = if at.is_finite() && at != 0.0 { at } else { 1.0 };
    for id in ids {
        let n = TRAILING.captures(&said(id)).and_then(|c| c[1].parse::<f64>().ok()).unwrap_or(0.0);
        next = next.max(n + 1.0);
    }
    next as i64
}

/// Parents before their sub-issues, as each row points at the one above it (`parentsFirst`).
fn parents_first<'a>(issues: &[&'a Row]) -> Result<Vec<&'a Row>> {
    let by_id: HashMap<String, &Row> = issues.iter().map(|issue| (said(&issue["id"]), *issue)).collect();
    let mut out = vec![];
    let mut placed = HashSet::new();
    for issue in issues {
        let mut chain = vec![];
        let mut seen = HashSet::new();
        let mut at = Some(*issue);
        while let Some(row) = at {
            let id = said(&row["id"]);
            if placed.contains(&id) {
                break;
            }
            if !seen.insert(id.clone()) {
                return Err(ApiError::bad_request(format!("That file's issue {id} is its own parent")));
            }
            chain.push(row);
            at = row.get("parent").and_then(|parent| by_id.get(&said(parent))).copied();
        }
        for row in chain.into_iter().rev() {
            placed.insert(said(&row["id"]));
            out.push(row);
        }
    }
    Ok(out)
}

/// A schedule's list of preset ids, as much of one as the file holds (`presetsOf`).
fn presets_of(value: Option<&Value>) -> Vec<Value> {
    let text = value.map(said).unwrap_or_default();
    serde_json::from_str::<Value>(&text).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

/// What the local app sends: the checked rows, and what the file says beside them.
pub struct Upload<'a> {
    pub id: &'a str,
    pub key: &'a str,
    pub name: Option<&'a str>,
    pub holder: &'a str,
    pub body: &'a Value,
}

/// Brings the board in, all or nothing, and says what it set off (the new board changed).
pub async fn upload_board(conn: &mut AnyConnection, upload: &Upload<'_>, actor: &Actor) -> Result<Effects> {
    let Upload { id, key, body, .. } = *upload;
    if !SLUG.is_match(id) {
        return Err(ApiError::bad_request(format!("\"{id}\" doesn't make a project's id")));
    }
    if !KEY.is_match(key) || RESERVED_KEYS.contains(&key) {
        return Err(ApiError::bad_request(format!("\"{key}\" doesn't make a project's key")));
    }
    let tables = body.get("tables").and_then(Value::as_object).ok_or_else(|| ApiError::bad_request("tables: the file's rows, checked"))?;
    if let Some(other) = tables.keys().find(|table| !TABLES.contains(&table.as_str())) {
        return Err(ApiError::bad_request(format!("tables: {other} isn't one a board's file holds")));
    }
    let projects = rows(tables.get("projects"));
    let [source] = projects.as_slice() else { return Err(ApiError::bad_request("That file should hold one project")) };
    changes::begin(conn).await?;
    let mut writer = Writer { conn, types: HashMap::new() };
    let done = writer.write(upload, source, tables, actor).await;
    let mut effects = Effects::default();
    effects.changed.push(id.to_string());
    let mut outbox = changes::Outbox::new(actor.clone());
    changes::finish(writer.conn, Some(&mut outbox), &effects, done).await?;
    Ok(effects)
}

struct Writer<'c> {
    conn: &'c mut AnyConnection,
    /// Each Postgres table's columns' types, for the casts the text sent as each needs.
    types: HashMap<String, HashMap<String, String>>,
}

impl Writer<'_> {
    async fn exists(&mut self, query: &str, binds: &[&str]) -> Result<bool> {
        let text = sql(query);
        let mut q = sqlx::query(&text);
        for bind in binds {
            q = q.bind(*bind);
        }
        Ok(q.fetch_optional(&mut *self.conn).await?.is_some())
    }

    async fn column_types(&mut self, table: &str) -> Result<HashMap<String, String>> {
        if let Some(types) = self.types.get(table) {
            return Ok(types.clone());
        }
        let found = sqlx::query(
            "SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a \
             WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped",
        )
        .bind(table)
        .fetch_all(&mut *self.conn)
        .await?;
        let types: HashMap<String, String> = found.iter().map(|row| (row.get::<String, _>("name"), row.get::<String, _>("type"))).collect();
        self.types.insert(table.to_string(), types.clone());
        Ok(types)
    }

    /// Adds a row as it is, each value a plain one; `returning` gives back the id it was numbered with here.
    async fn insert(&mut self, table: &str, row: &Row, returning: bool) -> Result<Option<i64>> {
        let keys: Vec<&String> = row.keys().collect();
        let types = if on_postgres() { self.column_types(table).await? } else { HashMap::new() };
        let place = |key: &str| match types.get(key) {
            Some(kind) => format!("CAST(? AS {kind})"),
            None => "?".to_string(),
        };
        let text = sql(&format!(
            "INSERT INTO {table} ({}) VALUES ({}){}",
            keys.iter().map(|key| format!("\"{key}\"")).collect::<Vec<_>>().join(", "),
            keys.iter().map(|key| place(key)).collect::<Vec<_>>().join(", "),
            if returning { " RETURNING id" } else { "" },
        ));
        let mut q = sqlx::query(&text);
        for key in &keys {
            let value = &row[key.as_str()];
            // Postgres casts the text to the column's type; SQLite keeps a number a number.
            q = match value {
                Value::Null => q.bind(None::<String>),
                Value::Number(n) if !on_postgres() => match whole(n) {
                    Some(n) => q.bind(n),
                    None => q.bind(n.as_f64()),
                },
                Value::Bool(b) if !on_postgres() => q.bind(i64::from(*b)),
                Value::Bool(b) => q.bind(Some(i64::from(*b).to_string())),
                other => q.bind(Some(said(other))),
            };
        }
        if returning {
            let made = q.fetch_one(&mut *self.conn).await?;
            Ok(Some(made.try_get::<i64, _>("id")?))
        } else {
            q.execute(&mut *self.conn).await?;
            Ok(None)
        }
    }

    async fn write(&mut self, upload: &Upload<'_>, source: &Row, tables: &Map<String, Value>, actor: &Actor) -> Result<()> {
        let Upload { id, key, name, holder, body } = *upload;
        if self.exists("SELECT 1 FROM projects WHERE id = ?", &[id]).await? {
            return Err(ApiError::conflict(format!("There is already a project \"{id}\": choose another id")));
        }
        if self.exists("SELECT 1 FROM projects WHERE key = ?", &[key]).await? {
            return Err(ApiError::conflict(format!("There is already a project with the key {key}: choose another")));
        }
        let now = stamp();
        let table = |name: &str| rows(tables.get(name));
        let file_project = body.get("project").cloned().unwrap_or(Value::Null);

        // Statuses by id, else the first of their kind. People by name, and an open issue with nobody here goes unassigned.
        let statuses: Vec<(String, String)> = sqlx::query("SELECT id, kind FROM statuses ORDER BY position")
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|row| (row.get::<String, _>("id"), row.get::<String, _>("kind")))
            .collect();
        let in_file = rows(body.get("statuses"));
        let status_for = |status: Option<&Value>| -> (String, String) {
            let status = status.map(said);
            if let Some(same) = statuses.iter().find(|(id, _)| Some(id) == status.as_ref()) {
                return same.clone();
            }
            let kind = in_file.iter().find(|s| s.get("id").map(said) == status).and_then(|s| s.get("kind")).map(said);
            statuses
                .iter()
                .find(|(_, k)| Some(k) == kind.as_ref())
                .or_else(|| statuses.iter().find(|(_, k)| k == "backlog"))
                .cloned()
                .unwrap_or_else(|| ("backlog".into(), "backlog".into()))
        };
        let people: Vec<(String, String)> = sqlx::query("SELECT id, name FROM people")
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|row| (row.get::<String, _>("id"), row.get::<String, _>("name")))
            .collect();
        let named: HashMap<String, String> = rows(body.get("people"))
            .iter()
            .map(|person| (person.get("id").map(said).unwrap_or_default().to_lowercase(), person.get("name").map(said).unwrap_or_default().to_lowercase()))
            .collect();
        let person_for = |who: Option<&Value>| -> Value {
            let Some(Value::String(who)) = who else { return Value::Null };
            let name = named.get(&who.to_lowercase()).cloned().unwrap_or_else(|| who.to_lowercase());
            people.iter().find(|(_, n)| n.to_lowercase() == name).map(|(id, _)| Value::String(id.clone())).unwrap_or(Value::Null)
        };
        let on_this_board = |row: &Row| -> Row {
            let mut row = row.clone();
            row.insert("project".into(), Value::String(id.to_string()));
            if row.contains_key("owned") {
                row.insert("owned".into(), 0.into());
            }
            row
        };
        let without_id = |row: &Row| -> Row {
            let mut row = row.clone();
            row.remove("id");
            row
        };

        self.bring_uploads(body.get("uploads"), actor).await?;

        // What points outside the board stays only where it leads somewhere here that the uploader may see.
        let releases_from = match source.get("releases_from") {
            Some(Value::String(from)) if self.exists("SELECT 1 FROM project_members WHERE project = ? AND person = ?", &[from.as_str(), holder]).await? => {
                Value::String(from.clone())
            }
            _ => Value::Null,
        };
        let mut project = source.clone();
        let mode = match source.get("release_mode") {
            Some(Value::String(mode)) if mode != "own" && releases_from.is_null() => Value::String("none".into()),
            Some(mode) => mode.clone(),
            None => Value::Null,
        };
        let issues = table("issues");
        let milestones = table("milestones");
        let next_number = past_ids(issues.iter().filter_map(|i| i.get("id")), source.get("next_number").unwrap_or(&Value::Null));
        let next_milestone = past_ids(milestones.iter().filter_map(|m| m.get("id")), source.get("next_milestone").unwrap_or(&Value::Null));
        for (column, value) in [
            ("id", Value::String(id.into())),
            ("key", Value::String(key.into())),
            ("name", name.map(|n| Value::String(n.into())).unwrap_or_else(|| source.get("name").cloned().unwrap_or(Value::Null))),
            ("uid", Value::String(uid_of(&hex(5)))),
            ("created_by", Value::String(actor.name.clone())),
            ("owned", i64::from(actor.owner).into()),
            ("focus_prompt", Value::Null),
            ("milestone_prompt", Value::Null),
            ("instructions", Value::String("[]".into())),
            ("starts", Value::Null),
            ("repo", Value::Null),
            ("releases_from", releases_from.clone()),
            ("release_mode", mode),
            ("next_number", next_number.into()),
            ("next_milestone", next_milestone.into()),
        ] {
            project.insert(column.into(), value);
        }
        self.insert("projects", &project, false).await?;
        sqlx::query(&sql("INSERT INTO project_members (project, person, role, created_at) VALUES (?, ?, 'owner', ?)"))
            .bind(id)
            .bind(holder)
            .bind(&now)
            .execute(&mut *self.conn)
            .await?;
        for member in table("project_members") {
            if let Value::String(person) = person_for(member.get("person")) {
                if person != holder {
                    let at = member.get("created_at").filter(|at| !at.is_null()).map(said).unwrap_or_else(|| now.clone());
                    sqlx::query(&sql("INSERT INTO project_members (project, person, role, created_at) VALUES (?, ?, 'member', ?) ON CONFLICT DO NOTHING"))
                        .bind(id)
                        .bind(&person)
                        .bind(&at)
                        .execute(&mut *self.conn)
                        .await?;
                }
            }
        }

        for name in ["milestones", "milestone_aliases", "doc_sections", "docs", "releases"] {
            for row in table(name) {
                let mut row = on_this_board(row);
                if name == "releases" {
                    row.insert("doc_mark".into(), Value::Null);
                }
                self.insert(name, &row, false).await?;
            }
        }

        let mut presets: HashMap<String, i64> = HashMap::new();
        for preset in table("presets") {
            let mut row = on_this_board(&without_id(preset));
            row.insert("default_key".into(), Value::Null);
            let made = self.insert("presets", &row, true).await?.unwrap_or_default();
            presets.insert(preset.get("id").map(said).unwrap_or_default(), made);
        }
        let mut schedules: HashMap<String, i64> = HashMap::new();
        for schedule in table("schedules") {
            let mut row = on_this_board(&without_id(schedule));
            let kept: Vec<Value> = presets_of(schedule.get("presets")).iter().filter_map(|p| presets.get(&said(p)).map(|&n| Value::from(n))).collect();
            for (column, value) in [
                ("enabled", Value::from(0)),
                ("next_run", Value::Null),
                ("place", Value::String(status_for(schedule.get("place")).0)),
                ("created_by", Value::String(actor.name.clone())),
                ("across", Value::Null),
                ("presets", Value::String(Value::Array(kept).to_string())),
            ] {
                row.insert(column.into(), value);
            }
            let made = self.insert("schedules", &row, true).await?.unwrap_or_default();
            schedules.insert(schedule.get("id").map(said).unwrap_or_default(), made);
        }
        let schedule_of = |value: Option<&Value>| value.and_then(|v| schedules.get(&said(v))).map_or(Value::Null, |&n| n.into());

        let versions: HashSet<String> = table("releases").iter().filter_map(|r| r.get("version")).map(said).collect();
        for issue in parents_first(&issues)? {
            let (status, kind) = status_for(issue.get("status"));
            let open = kind != "done" && kind != "canceled";
            let assignee = person_for(issue.get("assignee"));
            let mut row = issue.clone();
            let ships_in = issue.get("ships_in").cloned().unwrap_or(Value::Null);
            let keeps_ship = !releases_from.is_null() || (!ships_in.is_null() && versions.contains(&said(&ships_in)));
            for (column, value) in [
                ("status", Value::String(status)),
                ("assignee", if assignee.is_null() && !open { issue.get("assignee").cloned().unwrap_or(Value::Null) } else { assignee }),
                ("created_person", person_for(issue.get("created_person"))),
                ("claimed_by", Value::Null),
                ("claimed_at", Value::Null),
                ("claimed_session", Value::Null),
                ("session_name", Value::Null),
                ("ships_in", if keeps_ship { ships_in } else { Value::Null }),
                // Epics are the server's, not the board's (ORR-895), so a number from the file would name another one here.
                ("epic", Value::Null),
                ("schedule", schedule_of(issue.get("schedule"))),
            ] {
                row.insert(column.into(), value);
            }
            self.insert("issues", &on_this_board(&row), false).await?;
        }
        for alias in table("issue_aliases") {
            self.insert("issue_aliases", &on_this_board(alias), false).await?;
        }
        for link in table("issue_links") {
            let on = link.get("on_project").cloned().unwrap_or(Value::Null);
            let inside = on == file_project;
            if !inside {
                let Value::String(on) = &on else { continue };
                let issue = link.get("on_issue").map(said).unwrap_or_default();
                let seen = self.exists("SELECT 1 FROM project_members WHERE project = ? AND person = ?", &[on.as_str(), holder]).await?;
                if !seen || !self.exists("SELECT 1 FROM issues WHERE project = ? AND id = ?", &[on.as_str(), issue.as_str()]).await? {
                    continue;
                }
            }
            let mut row = on_this_board(link);
            row.insert("on_project".into(), if inside { Value::String(id.into()) } else { on });
            self.insert("issue_links", &row, false).await?;
        }

        for event in table("issue_events") {
            self.insert("issue_events", &on_this_board(&without_id(event)), false).await?;
        }
        // Said by whoever the file says, which is why it says it's the file's: no one here said it, and it asks nothing of anyone.
        let from_a_file = |row: &Row| Value::String(format!("{} (from a file)", row.get("created_by").map(said).unwrap_or_else(|| "undefined".into())));
        let mut comments: HashMap<String, i64> = HashMap::new();
        for comment in table("comments") {
            let mut row = on_this_board(&without_id(comment));
            for (column, value) in
                [("created_by", from_a_file(comment)), ("person", Value::Null), ("cleared", 1.into()), ("asks", Value::Null), ("session_name", Value::Null)]
            {
                row.insert(column.into(), value);
            }
            let made = self.insert("comments", &row, true).await?.unwrap_or_default();
            comments.insert(comment.get("id").map(said).unwrap_or_default(), made);
        }
        for comment in table("milestone_comments") {
            let mut row = on_this_board(&without_id(comment));
            for (column, value) in [("created_by", from_a_file(comment)), ("person", Value::Null), ("session_name", Value::Null)] {
                row.insert(column.into(), value);
            }
            self.insert("milestone_comments", &row, true).await?;
        }
        for request in table("schedule_requests") {
            let Some(&comment) = request.get("comment").and_then(|c| comments.get(&said(c))) else { continue };
            let mut row = request.clone();
            row.insert("comment".into(), comment.into());
            row.insert("schedule".into(), schedule_of(request.get("schedule")));
            if request.get("state").and_then(Value::as_str) == Some("asked") {
                row.insert("state".into(), Value::String("expired".into()));
            }
            self.insert("schedule_requests", &row, false).await?;
        }
        let mut revisions: HashMap<String, i64> = HashMap::new();
        for revision in table("doc_revisions") {
            let mut row = on_this_board(&without_id(revision));
            row.insert("session_name".into(), Value::Null);
            let made = self.insert("doc_revisions", &row, true).await?.unwrap_or_default();
            revisions.insert(revision.get("id").map(said).unwrap_or_default(), made);
        }
        for release in table("releases") {
            if let Some(&mark) = release.get("doc_mark").and_then(|m| revisions.get(&said(m))) {
                let version = release.get("version").map(said).unwrap_or_default();
                sqlx::query(&sql("UPDATE releases SET doc_mark = ? WHERE project = ? AND version = ?"))
                    .bind(mark)
                    .bind(id)
                    .bind(&version)
                    .execute(&mut *self.conn)
                    .await?;
            }
        }
        for run in table("schedule_runs") {
            let Some(&schedule) = run.get("schedule").and_then(|s| schedules.get(&said(s))) else { continue };
            let mut row = without_id(run);
            row.insert("schedule".into(), schedule.into());
            self.insert("schedule_runs", &row, false).await?;
        }

        // The board's history says where it came from.
        let exported = body.get("exported_at").and_then(Value::as_str);
        for issue in &issues {
            let issue = issue.get("id").map(said).unwrap_or_default();
            sqlx::query(&sql("INSERT INTO issue_events (project, issue, field, after, created_by, owned, created_at) VALUES (?, ?, 'uploaded', ?, ?, ?, ?)"))
                .bind(id)
                .bind(&issue)
                .bind(exported)
                .bind(&actor.name)
                .bind(i64::from(actor.owner))
                .bind(&now)
                .execute(&mut *self.conn)
                .await?;
        }
        Ok(())
    }

    /// The images the file's text shows: each checked as an image, by its bytes rather than what it says. One this
    /// server already has by that id stays as it is (`bringUploads`).
    async fn bring_uploads(&mut self, uploads: Option<&Value>, actor: &Actor) -> Result<()> {
        let Some(uploads) = uploads.and_then(Value::as_array) else { return Ok(()) };
        for upload in uploads {
            let unreadable = || ApiError::bad_request("That file holds an image it can't read");
            let upload = upload.as_object().ok_or_else(unreadable)?;
            let Some(Value::String(id)) = upload.get("id") else { return Err(unreadable()) };
            let Some(Value::String(data)) = upload.get("data") else { return Err(unreadable()) };
            if !UPLOAD_ID.is_match(id) {
                return Err(unreadable());
            }
            let bytes = decode(data);
            let Some(kind) = type_of(&bytes).filter(|_| bytes.len() <= UPLOAD_LIMIT) else {
                return Err(ApiError::bad_request(format!(
                    "That file's image {id} isn't a PNG, JPEG, GIF or WebP of {} MB at most",
                    UPLOAD_LIMIT / 1024 / 1024
                )));
            };
            if self.exists("SELECT 1 FROM uploads WHERE id = ?", &[id.as_str()]).await? {
                continue;
            }
            let name: Option<String> = upload.get("name").and_then(Value::as_str).map(|n| n.chars().take(200).collect());
            sqlx::query(&sql("INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"))
                .bind(id)
                .bind(kind)
                .bind(name)
                .bind(bytes.len() as i64)
                .bind(bytes)
                .bind(&actor.name)
                .bind(stamp())
                .execute(&mut *self.conn)
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "board_upload_tests.rs"]
mod tests;
