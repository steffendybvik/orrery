// The orrery's projects: listing them (ORR-997) and changing one (ORR-923), as `listProjects` and `updateProject` do
// (web/server/store/projects.ts), answering as `GET /api/projects` without `?expand=board` and `PATCH
// /api/projects/:project` do. Each project is its row as `projectOf` hands it out (base.ts), with its docs, doc
// sections and releases, and its board or, listed, the board's counts and kinds and how many milestones it has.
// Reading boards (`?expand=board`, `GET /api/projects/:project`) answers without the events stream's `rev`, which the
// Nuxt server's router adds. Making one (`createProject`) answers as `POST /api/projects` does, and deleting one (`deleteProject`) as
// `DELETE /api/projects/:project` does.
use crate::access::people::Who;
use crate::board::docs::Docs;
use crate::board::issue_writes::IssueWrites;
use crate::board::issues::{kinds_json, sum, Board, Issues};
use crate::board::plans::Plans;
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::migrate::uid_of;
use crate::text::{key_for, slugify, RESERVED_KEYS};
use crate::work::settings::hex;
use crate::write::{js, stamp, Actor, Effects};
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

/// Refuses the prompt fields to anyone but the owner (`promptsAreTheOwners`).
fn prompts_are_the_owners(input: &Map<String, Value>, actor: &Actor) -> Result<()> {
    let sent: Vec<&str> = PROMPT_FIELDS.into_iter().filter(|key| input.contains_key(*key)).collect();
    if !sent.is_empty() && !actor.owner {
        return Err(ApiError::refused_for(
            "prompts.write",
            format!("Only the owner changes what sessions are told ({}); send Orrery-Actor: <owner>", sent.join(", ")),
        ));
    }
    Ok(())
}

/// The prompt fields sent, as columns (`promptColumns`): an empty template is none (the orrery's); the lists are kept as JSON.
fn prompt_columns(input: &Map<String, Value>) -> Vec<(&'static str, Value)> {
    let mut sets = vec![];
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
    sets
}

/// What a project ships in after a change, from what it ships in now (`releaseModeOf`).
fn release_mode_of(input: &Map<String, Value>, mode: &str, from: &Option<String>) -> Result<(String, Option<String>)> {
    let releases_from = text(input, "releases_from");
    Ok(match input.get("release_mode").and_then(Value::as_str) {
        None => match &releases_from {
            Some(Some(from)) => ("shared".to_string(), Some(from.clone())),
            Some(None) if mode == "shared" => ("own".into(), None),
            _ => (mode.to_string(), from.clone()),
        },
        Some("shared") => match releases_from.unwrap_or_else(|| from.clone()) {
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
    })
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

    /// Every project, by name, each with its counts (`listProjects`), or, `boards`, with its whole board (`listBoards`).
    pub async fn list(&mut self, boards: bool) -> Result<Value> {
        let rows = sqlx::query(&sql(&format!("SELECT {PROJECT_COLUMNS} FROM projects ORDER BY lower(name), name"))).fetch_all(&mut *self.conn).await?;
        let starts = self.starts().await?;
        let mut out = Vec::new();
        for row in &rows {
            out.push(self.project_of(row, &starts, !boards).await?);
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

    /// Makes a project, held by whoever asks (the owner when it can't say), who can then say who else is on it
    /// (`createProject`). Gives back its id.
    pub async fn create(&mut self, body: &Value, who: Option<&Who>, actor: &Actor) -> Result<String> {
        let input = check_input(body, false)?;
        prompts_are_the_owners(&input, actor)?;
        let name = input.get("name").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let id = match input.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => slugify(&name),
        };
        if !SLUG.is_match(&id) {
            return Err(ApiError::bad_request(format!("\"{name}\" doesn't make an id; give one in \"id\"")));
        }
        if self.release_row(&id).await?.is_some() {
            return Err(ApiError::conflict(format!("There is already a project \"{id}\"")));
        }
        let key = match input.get("key").and_then(Value::as_str) {
            Some(key) => key.to_string(),
            None => key_for(&name),
        };
        if RESERVED_KEYS.contains(&key.as_str()) {
            return Err(ApiError::bad_request(format!(
                "\"{key}\" is how a milestone's, an epic's, a doc's, a preset's or a schedule's id starts; give another in \"key\""
            )));
        }
        let (mode, from) = release_mode_of(&input, "none", &None)?;
        if let Some(from) = &from {
            self.check_releases_from(&id, from).await?;
        }
        let holder = match IssueWrites::new(&mut *self.conn).person_asking(who, actor).await? {
            Some(holder) => holder,
            None => IssueWrites::new(&mut *self.conn).owner_id().await?,
        };
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let now = stamp();
            let field = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_string);
            sqlx::query(&sql(
                "INSERT INTO projects (id, name, key, uid, description, icon, icon_color, repo, release_mode, releases_from, created_by, owned, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ))
            .bind(&id)
            .bind(&name)
            .bind(&key)
            .bind(uid_of(&hex(5)))
            .bind(field("description"))
            .bind(field("icon"))
            .bind(field("icon_color"))
            .bind(field("repo"))
            .bind(&mode)
            .bind(&from)
            .bind(&actor.name)
            .bind(i64::from(actor.owner))
            .bind(&now)
            .bind(&now)
            .execute(&mut *self.conn)
            .await?;
            let sets = prompt_columns(&input);
            if !sets.is_empty() {
                let columns: Vec<String> = sets.iter().map(|(key, _)| format!("{key} = ?")).collect();
                let statement = sql(&format!("UPDATE projects SET {} WHERE id = ?", columns.join(", ")));
                let mut query = sqlx::query(&statement);
                for (_, value) in &sets {
                    query = query.bind(value.as_str().map(str::to_string));
                }
                query.bind(&id).execute(&mut *self.conn).await?;
            }
            sqlx::query(&sql("INSERT INTO project_members (project, person, role, created_at) SELECT ?, id, 'owner', ? FROM people WHERE id = ?"))
                .bind(&id)
                .bind(&now)
                .bind(&holder)
                .execute(&mut *self.conn)
                .await?;
            self.effects.changed = vec![id.clone()];
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        Ok(id)
    }

    /// Changes the project's fields; the prompt fields are the owner's (`updateProject`).
    pub async fn update(&mut self, id: &str, body: &Value, actor: &Actor) -> Result<()> {
        let row = self.release_row(id).await?.ok_or_else(|| ApiError::not_found(format!("No project \"{id}\"")))?;
        let input = check_input(body, true)?;
        prompts_are_the_owners(&input, actor)?;
        if input.get("id").and_then(Value::as_str).is_some_and(|sent| sent != id) {
            return Err(ApiError::bad_request("A project's id can't change"));
        }
        let (mode, from) = release_mode_of(&input, &row.mode, &row.from)?;
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
            sets.extend(prompt_columns(&input));
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

    /// What the owner made in the project, the project included (`ownedIn`).
    async fn owned_in(&mut self, id: &str, owned: bool) -> Result<Vec<String>> {
        let mut out = if owned { vec![format!("project \"{id}\"")] } else { vec![] };
        for (query, shown) in [
            ("SELECT id FROM milestones WHERE project = ? AND owned = 1", "milestone \"{}\""),
            ("SELECT id FROM docs WHERE project = ? AND owned = 1", "doc \"{}\""),
            ("SELECT version FROM releases WHERE project = ? AND owned = 1", "release {}"),
        ] {
            let ids: Vec<String> = sqlx::query_scalar(&sql(query)).bind(id).fetch_all(&mut *self.conn).await?;
            out.extend(ids.into_iter().map(|one| shown.replace("{}", &one)));
        }
        let issues: Vec<String> = sqlx::query_scalar(&sql("SELECT id FROM issues WHERE project = ?")).bind(id).fetch_all(&mut *self.conn).await?;
        if !issues.is_empty() {
            out.extend(IssueWrites::new(&mut *self.conn).owned_under(id, &issues).await?);
        }
        Ok(out)
    }

    /// Deletes the project and everything in it, for good (`deleteProject`). An agent can't while it holds anything the
    /// owner made, and nobody can while another project takes its releases from it.
    pub async fn delete(&mut self, id: &str, actor: &Actor) -> Result<()> {
        let owned: Option<i64> =
            sqlx::query_scalar(&sql("SELECT CAST(owned AS BIGINT) FROM projects WHERE id = ?")).bind(id).fetch_optional(&mut *self.conn).await?;
        let owned = owned.ok_or_else(|| ApiError::not_found(format!("No project \"{id}\"")))? != 0;
        if !actor.owner {
            let owned = self.owned_in(id, owned).await?;
            if !owned.is_empty() {
                let shown = if owned.len() > 4 { [owned[..3].to_vec(), vec![format!("{} more", owned.len() - 3)]].concat() } else { owned.clone() };
                let was = if owned.len() == 1 { "was" } else { "were" };
                return Err(ApiError::refused_for("issues.delete", format!("Deleting {id} is the owner's call: {} {was} made by the owner", shown.join(", "))));
            }
        }
        let drawing = self.drawing_on(id).await?;
        if !drawing.is_empty() {
            let one = drawing.len() == 1;
            return Err(ApiError::conflict(format!(
                "{} {} releases from {id}; give {} own first (releases_from: null)",
                drawing.join(", "),
                if one { "takes its" } else { "take their" },
                if one { "it its" } else { "them their" },
            )));
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            // Comments and issues first: the foreign keys would refuse the project going before them.
            for statement in [
                "DELETE FROM comments WHERE project = ?",
                "UPDATE issues SET parent = NULL, milestone = NULL WHERE project = ?",
                "DELETE FROM issues WHERE project = ?",
                "DELETE FROM milestones WHERE project = ?",
                "DELETE FROM docs WHERE project = ?",
                "DELETE FROM doc_sections WHERE project = ?",
                "DELETE FROM doc_revisions WHERE project = ?",
                "DELETE FROM releases WHERE project = ?",
                "DELETE FROM issue_aliases WHERE project = ?",
                "DELETE FROM milestone_aliases WHERE project = ?",
                "DELETE FROM signals WHERE project = ?",
                "DELETE FROM schedules WHERE project = ?",
                "DELETE FROM presets WHERE project = ?",
            ] {
                sqlx::query(&sql(statement)).bind(id).execute(&mut *self.conn).await?;
            }
            sqlx::query(&sql("DELETE FROM issue_links WHERE project = ? OR on_project = ?")).bind(id).bind(id).execute(&mut *self.conn).await?;
            sqlx::query(&sql("DELETE FROM projects WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
            self.effects.changed = vec![id.into()];
            // Its schedules went with it, for the local app's runner to drop.
            self.effects.schedules = vec![id.into()];
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }
}

/// Trims a project's board as the page's reads ask (`shared/patch.ts`): `notes` false drops each issue's notes, and
/// `closed` false drops the closed issues (done, canceled) that have no open sub-issue under them, so the tree holds.
pub fn trim_board(project: &mut Value, notes: bool, closed: bool) {
    fn trim(tasks: &mut Value, notes: bool, closed: bool) {
        let Some(list) = tasks.as_array_mut() else { return };
        for issue in list.iter_mut() {
            if let Some(issue) = issue.as_object_mut() {
                if !notes {
                    issue.remove("notes");
                }
                if let Some(sub) = issue.get_mut("tasks") {
                    trim(sub, notes, closed);
                }
            }
        }
        if !closed {
            list.retain(|issue| {
                let done = matches!(issue["kind"].as_str(), Some("done" | "canceled"));
                !done || issue["tasks"].as_array().is_some_and(|t| !t.is_empty())
            });
        }
    }
    if notes && closed {
        return;
    }
    if let Some(milestones) = project.pointer_mut("/board/milestones").and_then(Value::as_array_mut) {
        for milestone in milestones {
            if let Some(tasks) = milestone.get_mut("tasks") {
                trim(tasks, notes, closed);
            }
        }
    }
}
