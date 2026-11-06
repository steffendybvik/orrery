// The orrery's projects: listing them (ORR-997) and changing one (ORR-923), as `listProjects` and `updateProject` do
// (web/server/store/projects.ts), answering as `GET /api/projects` without `?expand=board` and `PATCH
// /api/projects/:project` do. Each project is its row as `projectOf` hands it out (base.ts), with its docs, doc
// sections and releases, and its board or, listed, the board's counts and kinds and how many milestones it has.
// Reading boards (`?expand=board`, `GET /api/projects/:project`) stays on the Nuxt server, as their `rev` is the events
// stream's; making and deleting projects stay there too.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::docs::{js, stamp, Actor, Docs, Effects};
use crate::error::{ApiError, Result};
use crate::issues::{kinds_json, sum, Board, Issues};
use crate::plans::Plans;
use crate::settings::hex;
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::sync::LazyLock;

const PROJECT_COLUMNS: &str = "id, name, key, uid, description, icon, icon_color, focus_prompt, milestone_prompt, instructions, muted, repo, \
    release_mode, releases_from, created_by, CAST(owned AS BIGINT) AS owned, created_at, updated_at";

/// `PROJECT_FIELDS`, in its order, as `checkInput` lists them.
const FIELDS: [&str; 13] = [
    "id",
    "name",
    "key",
    "description",
    "icon",
    "icon_color",
    "focus_prompt",
    "milestone_prompt",
    "instructions",
    "muted",
    "repo",
    "release_mode",
    "releases_from",
];
/// What sessions are told, the owner's to change (`PROMPT_FIELDS`).
const PROMPT_FIELDS: [&str; 4] = ["focus_prompt", "milestone_prompt", "instructions", "muted"];
const RELEASE_MODES: [&str; 3] = ["none", "own", "shared"];
const TINTS: [&str; 7] = ["slate", "blue", "teal", "green", "amber", "rose", "violet"];

static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,39}$").unwrap());
static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9]{0,9}$").unwrap());
static ICON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap());
static TINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^({}|#[0-9a-fA-F]{{6}})$", TINTS.join("|"))).unwrap());
static REPO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://\S+[^/\s]$").unwrap());

/// A string field's pattern and the hint its refusal gives, as `PROJECT_FIELDS` has them.
fn pattern_of(key: &str) -> Option<(&'static Regex, String)> {
    Some(match key {
        "id" => (&*SLUG, "use lowercase letters, digits and dashes".into()),
        "key" => (&*KEY, "use capitals and digits, starting with a capital, e.g. GRE".into()),
        "icon" => (&*ICON, "use a Heroicon's name, e.g. shopping-cart".into()),
        "icon_color" => (&*TINT, format!("use {} or a colour like #3b82f6", TINTS.join(", "))),
        "repo" => (&*REPO, "use the web address of its code, e.g. https://github.com/you/shop".into()),
        "releases_from" => (&*SLUG, "use the other project's id".into()),
        _ => return None,
    })
}

/// A body as `checkInput(body, PROJECT_FIELDS, partial)` takes it.
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
            if !partial && key == "name" {
                problems.push("missing \"name\"".into());
            }
            continue;
        };
        if value.is_null() {
            if matches!(key, "id" | "name" | "key" | "release_mode") {
                problems.push(format!("\"{key}\" can't be null"));
            } else {
                input.insert(key.into(), Value::Null);
            }
            continue;
        }
        match key {
            "instructions" => {
                let lines: Option<Vec<Value>> = value.as_array().and_then(|lines| {
                    lines
                        .iter()
                        .map(|line| {
                            let text = line.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty())?;
                            let (id, on) = (line.get("id"), line.get("on"));
                            if id.is_some_and(|id| !id.is_string()) || on.is_some_and(|on| !on.is_boolean()) {
                                return None;
                            }
                            let id = id.and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string).unwrap_or_else(|| hex(4));
                            Some(json!({"id": id, "text": text.trim(), "on": on.and_then(Value::as_bool).unwrap_or(true)}))
                        })
                        .collect()
                });
                match lines {
                    Some(lines) => {
                        input.insert(key.into(), Value::Array(lines));
                    }
                    None => problems.push(format!("\"{key}\" should be a list of {{text, on?, id?}}, not {}", js(value))),
                }
            }
            "muted" => match value.as_array().filter(|l| l.iter().all(|v| v.as_str().is_some_and(|v| !v.trim().is_empty()))) {
                Some(list) => {
                    let mut ids: Vec<String> = vec![];
                    for id in list.iter().filter_map(Value::as_str).map(|v| v.trim().to_string()) {
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                    input.insert(key.into(), json!(ids));
                }
                None => problems.push(format!("\"{key}\" should be a list of strings, not {}", js(value))),
            },
            _ => {
                let Some(text) = value.as_str() else {
                    problems.push(format!("\"{key}\" should be a string, not {}", js(value)));
                    continue;
                };
                if key == "release_mode" && !RELEASE_MODES.contains(&text) {
                    problems.push(format!("\"{key}\" is \"{text}\", not one of {}", RELEASE_MODES.join(", ")));
                    continue;
                }
                if let Some((pattern, hint)) = pattern_of(key) {
                    if !pattern.is_match(text) {
                        problems.push(format!("\"{key}\" is \"{text}\"; {hint}"));
                        continue;
                    }
                }
                if key == "name" && text.trim().is_empty() {
                    problems.push("\"name\" can't be empty".into());
                    continue;
                }
                input.insert(key.into(), value.clone());
            }
        }
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(input)
}

/// A JSON column as it was kept, or `fallback` when it doesn't parse.
fn parsed(text: Option<String>, fallback: Value) -> Value {
    text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(fallback)
}

/// The board as `readBoard` hands it out: its milestones, each with its issues, and the counts and kinds of them all.
fn board_json(board: &Board) -> Value {
    let (mut counts, mut kinds) = (Map::new(), [0; 6]);
    let mut milestones = Vec::new();
    for group in &board.milestones {
        for task in &group.tasks {
            sum(&mut counts, &mut kinds, task);
        }
        let mut out = group.fields.clone();
        if group.id.is_empty() {
            // The issues in no milestone, as `buildBoard` makes them one more.
            out.insert("id".into(), json!(""));
            out.insert("title".into(), json!("No milestone"));
            out.insert("aliases".into(), json!([]));
            out.insert("created_by".into(), json!(""));
            out.insert("protected".into(), json!(false));
        }
        for row_only in ["project", "position", "created_at", "updated_at"] {
            out.remove(row_only);
        }
        out.insert("tasks".into(), Value::Array(group.tasks.iter().map(|t| t.json()).collect()));
        milestones.push(Value::Object(out));
    }
    json!({"milestones": milestones, "counts": counts, "kinds": kinds_json(&kinds)})
}

/// A text field as sent: absent, null, or its text.
fn text(input: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    input.get(key).map(|v| v.as_str().map(str::to_string))
}

/// The project's row as far as changing its releases takes it.
struct ReleaseRow {
    id: String,
    mode: String,
    from: Option<String>,
}

pub struct Projects<'c> {
    conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Projects<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Projects { conn, effects: Effects::default(), outbox: None }
    }

    /// Whether orrery may start sessions, and within what: the orrery's setting, as every project shares it (`orreryStarts`).
    async fn starts(&mut self) -> Result<Option<Value>> {
        let row = sqlx::query(&sql("SELECT value FROM settings WHERE key = ?")).bind("starts").fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|r| parsed(r.get("value"), Value::Null)).filter(|v| !v.is_null()))
    }

    /// The project as `projectOf` makes it, with its whole board, or, `listed`, the board's counts in its place.
    async fn project_of(&mut self, row: &AnyRow, starts: &Option<Value>, listed: bool) -> Result<Value> {
        let id: String = row.get("id");
        let mut project = Map::new();
        project.insert("id".into(), json!(id));
        for column in ["name", "key", "uid", "created_by", "created_at", "updated_at", "release_mode"] {
            project.insert(column.into(), json!(row.get::<Option<String>, _>(column).unwrap_or_default()));
        }
        // What the store leaves undefined, and so out of its reply, is left out here too.
        for column in ["description", "icon", "icon_color", "focus_prompt", "milestone_prompt", "repo", "releases_from"] {
            if let Some(value) = row.get::<Option<String>, _>(column) {
                project.insert(column.into(), json!(value));
            }
        }
        project.insert("instructions".into(), parsed(row.get("instructions"), json!([])));
        project.insert("muted".into(), parsed(row.get("muted"), json!([])));
        if let Some(starts) = starts {
            project.insert("starts".into(), starts.clone());
        }
        project.insert("protected".into(), json!(row.get::<i64, _>("owned") != 0));
        let mut docs = Docs::new(&mut *self.conn);
        project.insert("docs".into(), docs.list(&id, None).await?);
        project.insert("doc_sections".into(), docs.sections(&id).await?);
        let mut issues = Issues::new(&mut *self.conn);
        let statuses = issues.statuses().await?;
        let (board, releases) = Plans::new(&mut issues).board_and_releases(&id, &statuses).await?;
        project.insert("releases".into(), Value::Array(releases.into_iter().map(Value::Object).collect()));
        let whole = board_json(&board);
        if listed {
            project.insert("counts".into(), whole["counts"].clone());
            project.insert("kinds".into(), whole["kinds"].clone());
            project.insert("milestones".into(), json!(board.milestones.iter().filter(|g| !g.id.is_empty()).count()));
        } else {
            project.insert("board".into(), whole);
        }
        Ok(Value::Object(project))
    }

    /// Every project, by name, each with its counts (`listProjects`).
    pub async fn list(&mut self) -> Result<Value> {
        let rows = sqlx::query(&sql(&format!("SELECT {PROJECT_COLUMNS} FROM projects ORDER BY lower(name), name"))).fetch_all(&mut *self.conn).await?;
        let starts = self.starts().await?;
        let mut out = Vec::new();
        for row in &rows {
            out.push(self.project_of(row, &starts, true).await?);
        }
        Ok(Value::Array(out))
    }

    /// The project with its board (`project`), without the `rev` the Nuxt server's read adds.
    pub async fn project(&mut self, id: &str) -> Result<Value> {
        let row = sqlx::query(&sql(&format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?")))
            .bind(id)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No project \"{id}\"")))?;
        let starts = self.starts().await?;
        self.project_of(&row, &starts, false).await
    }

    async fn release_row(&mut self, id: &str) -> Result<Option<ReleaseRow>> {
        let row = sqlx::query(&sql("SELECT id, release_mode, releases_from FROM projects WHERE id = ?")).bind(id).fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|r| ReleaseRow { id: r.get("id"), mode: r.get::<Option<String>, _>("release_mode").unwrap_or_default(), from: r.get("releases_from") }))
    }

    /// The projects taking their releases from `id`, by id (`drawingOn`).
    async fn drawing_on(&mut self, id: &str) -> Result<Vec<String>> {
        let rows = sqlx::query(&sql("SELECT id FROM projects WHERE releases_from = ? ORDER BY id")).bind(id).fetch_all(&mut *self.conn).await?;
        Ok(rows.iter().map(|r| r.get("id")).collect())
    }

    /// Whether `id` can take its releases from `from`: another project with releases of its own, one level only (`checkReleasesFrom`).
    async fn check_releases_from(&mut self, id: &str, from: &str) -> Result<()> {
        if from == id {
            return Err(ApiError::bad_request("A project can't take its releases from itself; send release_mode \"own\" to give it its own"));
        }
        let Some(source) = self.release_row(from).await? else {
            return Err(ApiError::bad_request(format!("No project \"{from}\" to take releases from")));
        };
        let theirs = source.from.unwrap_or_default();
        match source.mode.as_str() {
            "shared" => Err(ApiError::bad_request(format!("{from} takes its releases from {theirs}; take them from {theirs} too"))),
            "none" => Err(ApiError::bad_request(format!("{from} has no releases; give it its own first (release_mode \"own\")"))),
            _ => Ok(()),
        }
    }

    /// Whether the project can leave its own releases, and take another's when it does (`checkReleaseMode`).
    async fn check_release_mode(&mut self, row: &ReleaseRow, mode: &str, from: Option<&str>) -> Result<()> {
        if row.mode == "own" && mode != "own" {
            let drawing = self.drawing_on(&row.id).await?;
            if !drawing.is_empty() {
                let takes = if drawing.len() == 1 { "takes its" } else { "take their" };
                return Err(ApiError::conflict(format!("{} {takes} releases from {}, so it keeps its own", drawing.join(", "), row.id)));
            }
            let own = sqlx::query(&sql("SELECT version FROM releases WHERE project = ? ORDER BY version")).bind(&row.id).fetch_all(&mut *self.conn).await?;
            if !own.is_empty() {
                let versions: Vec<String> = own.iter().map(|r| r.get("version")).collect();
                let lost = if mode == "shared" { format!("nothing merges into {}'s", from.unwrap_or_default()) } else { "nothing goes quietly".into() };
                return Err(ApiError::conflict(format!("{} has releases of its own ({}); delete them first, {lost}", row.id, versions.join(", "))));
            }
        }
        if let Some(from) = from {
            self.check_releases_from(&row.id, from).await?;
        }
        Ok(())
    }

    /// Changes the project's fields; the prompt fields are the owner's (`updateProject`).
    pub async fn update(&mut self, id: &str, body: &Value, actor: &Actor) -> Result<()> {
        let row = self.release_row(id).await?.ok_or_else(|| ApiError::not_found(format!("No project \"{id}\"")))?;
        let input = check_input(body, true)?;
        let sent: Vec<&str> = PROMPT_FIELDS.into_iter().filter(|key| input.contains_key(*key)).collect();
        if !sent.is_empty() && !actor.owner {
            return Err(ApiError::refused_for(
                "prompts.write",
                format!("Only the owner changes what sessions are told ({}); send Orrery-Actor: <owner>", sent.join(", ")),
            ));
        }
        if input.get("id").and_then(Value::as_str).is_some_and(|sent| sent != id) {
            return Err(ApiError::bad_request("A project's id can't change"));
        }
        // `releaseModeOf`: what it ships in after this change.
        let releases_from = text(&input, "releases_from");
        let (mode, from) = match input.get("release_mode").and_then(Value::as_str) {
            None => match &releases_from {
                Some(Some(from)) => ("shared".to_string(), Some(from.clone())),
                Some(None) if row.mode == "shared" => ("own".into(), None),
                _ => (row.mode.clone(), row.from.clone()),
            },
            Some("shared") => match releases_from.clone().unwrap_or_else(|| row.from.clone()) {
                Some(source) => ("shared".into(), Some(source)),
                None => return Err(ApiError::bad_request("Say whose releases it ships in: \"releases_from\" with the other project's id")),
            },
            Some(asked) => {
                if let Some(Some(_)) = releases_from {
                    return Err(ApiError::bad_request(format!(
                        "A project with release_mode \"{asked}\" takes no other's releases; send \"shared\" with \"releases_from\", or leave it out"
                    )));
                }
                (asked.to_string(), None)
            }
        };
        let moved = mode != row.mode || from != row.from;
        if moved {
            self.check_release_mode(&row, &mode, from.as_deref()).await?;
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            // Each column with what it's set to, as `update` sets only those sent.
            let mut sets: Vec<(&str, Value)> = vec![];
            for key in ["name", "key", "description", "icon", "icon_color", "repo"] {
                if let Some(value) = input.get(key) {
                    sets.push((key, if key == "name" { json!(value.as_str().unwrap_or_default().trim()) } else { value.clone() }));
                }
            }
            sets.push(("release_mode", json!(mode)));
            sets.push(("releases_from", json!(from)));
            // An empty template is none (the orrery's); the lists are kept as JSON.
            for key in ["focus_prompt", "milestone_prompt"] {
                if let Some(value) = input.get(key) {
                    sets.push((key, value.as_str().map(str::trim).filter(|t| !t.is_empty()).map_or(Value::Null, |t| json!(t))));
                }
            }
            for key in ["instructions", "muted"] {
                if let Some(value) = input.get(key) {
                    sets.push((key, json!(if value.is_null() { "[]".to_string() } else { value.to_string() })));
                }
            }
            let columns: Vec<String> = sets.iter().map(|(key, _)| format!("{key} = ?")).chain(["updated_at = ?".to_string()]).collect();
            let statement = sql(&format!("UPDATE projects SET {} WHERE id = ?", columns.join(", ")));
            let mut query = sqlx::query(&statement);
            for (_, value) in &sets {
                query = query.bind(value.as_str().map(str::to_string));
            }
            query.bind(stamp()).bind(id).execute(&mut *self.conn).await?;
            // Its issues keep only the releases the new source has: none without releases, or back on its own (it has none yet).
            if moved {
                let source = match mode.as_str() {
                    "shared" => from.clone(),
                    "own" => Some(id.to_string()),
                    _ => None,
                };
                match source {
                    Some(source) => {
                        sqlx::query(&sql("UPDATE issues SET ships_in = NULL WHERE project = ? AND ships_in IS NOT NULL AND ships_in NOT IN (SELECT version FROM releases WHERE project = ?)"))
                            .bind(id)
                            .bind(source)
                            .execute(&mut *self.conn)
                            .await?;
                    }
                    None => {
                        sqlx::query(&sql("UPDATE issues SET ships_in = NULL WHERE project = ?")).bind(id).execute(&mut *self.conn).await?;
                    }
                }
            }
            self.effects.changed = vec![id.into()];
            // The old source counted its issues, and the new one does now.
            if let Some(before) = row.from.clone().filter(|before| Some(before) != from.as_ref()) {
                self.effects.changed.push(before);
            }
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }
}
