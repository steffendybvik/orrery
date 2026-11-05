// A project's docs, their sections and their revisions (ORR-922): what web/server/store/docs.ts does, on the same
// tables, answering as its routes under web/server/api/projects/[project]/ do. api/openapi.yaml is the contract.
// What a write sets off (open pages reading the project again, the event log, schedules hearing `doc.created`) stays
// the Nuxt server's: each write says what changed in its reply (`Effects`), and the router there tells them.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::text::{doc_summary_of, first_chars, full_doc_id, is_slug, looks_full_doc, match_of, natural_cmp, short_doc_id, slugify};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

/// Who a request is, as the Nuxt server's `actorOf` worked it out: only its name, whether it's the owner, and the
/// session's name, which are all a doc keeps.
#[derive(Clone, Debug, Default)]
pub struct Actor {
    pub name: String,
    pub owner: bool,
    pub session: Option<String>,
}

/// What a write changed, for the Nuxt server to tell: the projects (`changed`), whether the orrery's settings did, as
/// the statuses are in them (`settings`, ORR-926), and each event (`tell`).
#[derive(Default, Debug)]
pub struct Effects {
    pub changed: Vec<String>,
    pub settings: bool,
    pub told: Vec<(String, String, String)>,
    /// The settings sent in a change (ORR-954), for the router's note in the event log.
    pub settings_keys: Vec<String>,
}

impl Effects {
    fn tell(&mut self, kind: &str, project: &str, subject: &str) {
        self.told.push((kind.into(), project.into(), subject.into()))
    }
}

const DOC_COLUMNS: &str = "project, id, title, body, kind, section, created_by, CAST(owned AS BIGINT) AS owned, created_at, updated_at";
const REVISION_COLUMNS: &str = "CAST(id AS BIGINT) AS id, project, doc, title, kind, section, CAST(deleted AS BIGINT) AS deleted, created_by, session_name, CAST(owned AS BIGINT) AS owned, created_at";
/// The largest id a revision's column can hold: past it there's no such revision.
const MOST_REVISIONS: i64 = 2_147_483_647;
const DOC_FIELDS: [&str; 6] = ["id", "title", "body", "position", "section", "kind"];
const DOC_KINDS: [&str; 2] = ["markdown", "artifact"];

#[derive(Clone, Debug)]
struct DocRow {
    project: String,
    id: String,
    title: String,
    body: String,
    kind: String,
    section: Option<String>,
    created_by: String,
    owned: i64,
    created_at: String,
    updated_at: String,
}

impl DocRow {
    fn of(row: &AnyRow) -> Self {
        DocRow {
            project: row.get("project"),
            id: row.get("id"),
            title: row.get("title"),
            body: row.get("body"),
            kind: row.get("kind"),
            section: row.get("section"),
            created_by: row.get("created_by"),
            owned: row.get("owned"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        }
    }
}

#[derive(Clone, Debug)]
struct RevisionRow {
    id: i64,
    project: String,
    doc: String,
    title: String,
    body: Option<String>,
    kind: String,
    section: Option<String>,
    deleted: i64,
    created_by: String,
    session_name: Option<String>,
    owned: i64,
    created_at: String,
}

impl RevisionRow {
    fn of(row: &AnyRow) -> Self {
        RevisionRow {
            id: row.get("id"),
            project: row.get("project"),
            doc: row.get("doc"),
            title: row.get("title"),
            body: row.try_get("body").ok(),
            kind: row.get("kind"),
            section: row.get("section"),
            deleted: row.get("deleted"),
            created_by: row.get("created_by"),
            session_name: row.get("session_name"),
            owned: row.get("owned"),
            created_at: row.get("created_at"),
        }
    }

    fn summary(&self) -> Value {
        let mut out = json!({"id": self.id, "title": self.title, "kind": self.kind, "deleted": self.deleted != 0, "created_by": self.created_by});
        if let Some(name) = self.session_name.as_deref().filter(|s| !s.is_empty()) {
            out["session_name"] = json!(name);
        }
        out["created_at"] = json!(self.created_at);
        out
    }
}

fn summary_json(row: &DocRow, matched: Option<String>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(row.id));
    out.insert("title".into(), json!(row.title));
    out.insert("kind".into(), json!(row.kind));
    out.insert("summary".into(), json!(doc_summary_of(&row.kind, &row.body)));
    if let Some(matched) = matched {
        out.insert("match".into(), json!(matched));
    }
    if let Some(section) = row.section.as_deref().filter(|s| !s.is_empty()) {
        out.insert("section".into(), json!(section));
    }
    out.insert("created_by".into(), json!(row.created_by));
    out.insert("protected".into(), json!(row.owned != 0));
    out.insert("created_at".into(), json!(row.created_at));
    out.insert("updated_at".into(), json!(row.updated_at));
    out
}

pub fn stamp() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn js(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// A body's fields as `checkInput` takes them against `DOC_FIELDS`: unknown ones refused, each checked for its type.
/// `partial` is an update, where nothing is required.
fn check_doc_input(body: &Value, partial: bool) -> Result<Map<String, Value>> {
    let Some(object) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
    let mut problems = vec![];
    for key in object.keys() {
        if !DOC_FIELDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", DOC_FIELDS.join(", ")));
        }
    }
    let mut input = Map::new();
    for key in DOC_FIELDS {
        let Some(value) = object.get(key) else {
            if key == "title" && !partial {
                problems.push("missing \"title\"".into())
            }
            continue;
        };
        if value.is_null() {
            if key == "section" {
                input.insert(key.into(), Value::Null);
            } else {
                problems.push(format!("\"{key}\" can't be null"))
            }
            continue;
        }
        if key == "position" {
            if value.is_number() {
                input.insert(key.into(), value.clone());
            } else {
                problems.push(format!("\"{key}\" should be a number, not {}", js(value)))
            }
            continue;
        }
        let Some(text) = value.as_str() else {
            problems.push(format!("\"{key}\" should be a string, not {}", js(value)));
            continue;
        };
        if key == "kind" && !DOC_KINDS.contains(&text) {
            problems.push(format!("\"kind\" is \"{text}\", not one of {}", DOC_KINDS.join(", ")));
            continue;
        }
        if key == "id" && !is_slug(text) {
            problems.push(format!("\"id\" is \"{text}\"; use lowercase letters, digits and dashes"));
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

/// A doc's section as sent: trimmed, and none for an empty one; `None` leaves it as it is.
fn section_of(value: Option<&Value>) -> Option<Option<String>> {
    let value = value?;
    let text = match value {
        Value::Null => String::new(),
        Value::String(s) => first_chars(s.trim(), 60),
        other => first_chars(other.to_string().trim(), 60),
    };
    Some(if text.is_empty() { None } else { Some(text) })
}

/// A section's name as sent in `{name}`: trimmed, up to 60 characters, and not empty.
fn section_name(body: &Value) -> Result<String> {
    body.get("name")
        .filter(|n| n.is_string())
        .and_then(|n| section_of(Some(n)).flatten())
        .ok_or_else(|| ApiError::bad_request("A section needs a name: {name}, up to 60 characters"))
}

fn text_of(input: &Map<String, Value>, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_string)
}

pub struct Docs<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Docs<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Docs { conn, effects: Effects::default(), outbox: None }
    }

    async fn begin(&mut self) -> Result<()> {
        changes::begin(self.conn).await
    }

    /// Ends the transaction `begin` started: kept, with its outbox rows, when its work went through, else rolled back.
    /// What it set off is in `effects` by then.
    async fn finish<T>(&mut self, done: Result<T>) -> Result<T> {
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn exists(&mut self, query: &str, project: &str, key: &str) -> Result<bool> {
        Ok(sqlx::query(&sql(query)).bind(project).bind(key).fetch_optional(&mut *self.conn).await?.is_some())
    }

    /// The project's random id (its `uid`), or a 404 when there's no such project.
    async fn project_uid(&mut self, project: &str) -> Result<String> {
        let row = sqlx::query(&sql("SELECT uid FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await?;
        row.map(|r| r.get::<Option<String>, _>("uid").unwrap_or_default()).ok_or_else(|| ApiError::not_found(format!("No project \"{project}\"")))
    }

    async fn doc_row(&mut self, project: &str, id: &str) -> Result<DocRow> {
        self.project_uid(project).await?;
        self.find_doc(project, id).await?.ok_or_else(|| ApiError::not_found(format!("No doc \"{id}\" in {project}")))
    }

    async fn find_doc(&mut self, project: &str, id: &str) -> Result<Option<DocRow>> {
        let row = sqlx::query(&sql(&format!("SELECT {DOC_COLUMNS} FROM docs WHERE project = ? AND id = ?")))
            .bind(project)
            .bind(id)
            .fetch_optional(&mut *self.conn)
            .await?;
        Ok(row.as_ref().map(DocRow::of))
    }

    /// The doc's id, from its id or its full form on this board.
    async fn doc_id(&mut self, project: &str, id: &str) -> Result<String> {
        if self.exists("SELECT 1 FROM docs WHERE project = ? AND id = ?", project, id).await? {
            return Ok(id.into());
        }
        let uid = self.project_uid(project).await?;
        Ok(short_doc_id(id, &uid).unwrap_or_else(|| id.into()))
    }

    async fn touch_project(&mut self, project: &str) -> Result<()> {
        sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(stamp()).bind(project).execute(&mut *self.conn).await?;
        Ok(())
    }

    async fn next_position(&mut self, project: &str) -> Result<f64> {
        let row = sqlx::query(&sql("SELECT CAST(max(position) AS DOUBLE PRECISION) AS n FROM docs WHERE project = ?"))
            .bind(project)
            .fetch_one(&mut *self.conn)
            .await?;
        Ok(row.get::<Option<f64>, _>("n").unwrap_or(-1.0) + 1.0)
    }

    fn changed(&mut self, project: &str) {
        self.effects.changed = vec![project.into()]
    }

    // Reading.

    pub async fn list(&mut self, project: &str, q: Option<&str>) -> Result<Value> {
        self.project_uid(project).await?;
        let words: Vec<String> = q.unwrap_or("").to_lowercase().split_whitespace().map(str::to_string).collect();
        let rows = sqlx::query(&sql(&format!("SELECT {DOC_COLUMNS} FROM docs WHERE project = ?"))).bind(project).fetch_all(&mut *self.conn).await?;
        let mut docs: Vec<DocRow> = rows
            .iter()
            .map(DocRow::of)
            .filter(|row| {
                let text = format!("{}\n{}", row.title, row.body).to_lowercase();
                words.iter().all(|w| text.contains(w.as_str()))
            })
            .collect();
        let in_title = |row: &DocRow| {
            let title = row.title.to_lowercase();
            words.iter().all(|w| title.contains(w.as_str()))
        };
        docs.sort_by(|a, b| in_title(b).cmp(&in_title(a)).then_with(|| natural_cmp(&a.title, &b.title)).then_with(|| a.id.cmp(&b.id)));
        Ok(Value::Array(docs.iter().map(|row| Value::Object(summary_json(row, (!words.is_empty()).then(|| match_of(&row.body, &words))))).collect()))
    }

    pub async fn doc(&mut self, project: &str, id: &str) -> Result<Value> {
        let id = self.doc_id(project, id).await?;
        let row = self.doc_row(project, &id).await?;
        let uid = self.project_uid(project).await?;
        let mut out = summary_json(&row, None);
        // As `docOf` lays it out: the project after the id, and its text and full id with it.
        let mut doc = Map::new();
        for (key, value) in out.iter_mut() {
            doc.insert(key.clone(), value.take());
            if key == "id" {
                doc.insert("project".into(), json!(row.project));
            }
        }
        doc.insert("body".into(), json!(row.body));
        doc.insert("full_id".into(), json!(full_doc_id(&row.id, &uid)));
        Ok(Value::Object(doc))
    }

    pub async fn revisions(&mut self, project: &str, sent: &str) -> Result<Value> {
        self.project_uid(project).await?;
        let id = self.doc_id(project, sent).await?;
        let rows = sqlx::query(&sql(&format!("SELECT {REVISION_COLUMNS} FROM doc_revisions WHERE project = ? AND doc = ? ORDER BY id DESC")))
            .bind(project)
            .bind(&id)
            .fetch_all(&mut *self.conn)
            .await?;
        if rows.is_empty() {
            return Err(ApiError::not_found(format!("No doc \"{id}\" in {project}, and none deleted")));
        }
        Ok(Value::Array(rows.iter().map(|r| RevisionRow::of(r).summary()).collect()))
    }

    async fn revision_row(&mut self, project: &str, sent: &str, revision: &str) -> Result<RevisionRow> {
        self.project_uid(project).await?;
        let id = self.doc_id(project, sent).await?;
        let number = revision.parse::<i64>().ok().filter(|n| *n > 0 && *n <= MOST_REVISIONS);
        let row = match number {
            Some(n) => {
                sqlx::query(&sql(&format!("SELECT {REVISION_COLUMNS}, body FROM doc_revisions WHERE project = ? AND doc = ? AND id = ?")))
                    .bind(project)
                    .bind(&id)
                    .bind(n)
                    .fetch_optional(&mut *self.conn)
                    .await?
            }
            None => None,
        };
        row.as_ref().map(RevisionRow::of).ok_or_else(|| ApiError::not_found(format!("No revision {revision} of doc \"{id}\" in {project}")))
    }

    pub async fn revision(&mut self, project: &str, id: &str, revision: &str) -> Result<Value> {
        let row = self.revision_row(project, id, revision).await?;
        let mut out = row.summary();
        out["project"] = json!(row.project);
        out["doc"] = json!(row.doc);
        out["body"] = json!(row.body.unwrap_or_default());
        Ok(out)
    }

    /// The project's docs that are gone: those whose newest revision says so, the latest removed first.
    pub async fn deleted(&mut self, project: &str) -> Result<Value> {
        self.project_uid(project).await?;
        let rows = sqlx::query(&sql("SELECT CAST(r.id AS BIGINT) AS id, r.doc, r.title, r.body, r.kind, r.created_by, r.created_at FROM doc_revisions r
            WHERE r.project = ? AND r.deleted = 1 AND r.id = (SELECT max(n.id) FROM doc_revisions n WHERE n.project = r.project AND n.doc = r.doc)
            ORDER BY r.id DESC"))
        .bind(project)
        .fetch_all(&mut *self.conn)
        .await?;
        Ok(Value::Array(
            rows.iter()
                .map(|r| {
                    let (kind, body): (String, String) = (r.get("kind"), r.get("body"));
                    json!({"id": r.get::<String, _>("doc"), "title": r.get::<String, _>("title"), "summary": doc_summary_of(&kind, &body), "kind": kind,
                "revision": r.get::<i64, _>("id"), "deleted_by": r.get::<String, _>("created_by"), "deleted_at": r.get::<String, _>("created_at")})
                })
                .collect(),
        ))
    }

    /// The project's sections: as arranged (`projects.doc_section_order`), then the rest A–Z; the ones docs are filed
    /// under, and empty ones made.
    async fn read_sections(&mut self, project: &str) -> Result<Vec<String>> {
        let mut names: Vec<String> = sqlx::query(&sql("SELECT name FROM doc_sections WHERE project = ?"))
            .bind(project)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| r.get("name"))
            .collect();
        for row in
            sqlx::query(&sql("SELECT DISTINCT section FROM docs WHERE project = ? AND section IS NOT NULL")).bind(project).fetch_all(&mut *self.conn).await?
        {
            let name: String = row.get("section");
            if !names.contains(&name) {
                names.push(name)
            }
        }
        let order = sqlx::query(&sql("SELECT doc_section_order FROM projects WHERE id = ?"))
            .bind(project)
            .fetch_optional(&mut *self.conn)
            .await?
            .map(|r| r.get::<String, _>("doc_section_order"))
            .unwrap_or_else(|| "[]".into());
        let arranged: Vec<String> = serde_json::from_str::<Vec<String>>(&order).unwrap_or_default().into_iter().filter(|n| names.contains(n)).collect();
        let mut rest: Vec<String> = names.into_iter().filter(|n| !arranged.contains(n)).collect();
        rest.sort_by(|a, b| natural_cmp(a, b));
        Ok(arranged.into_iter().chain(rest).collect())
    }

    pub async fn sections(&mut self, project: &str) -> Result<Value> {
        self.project_uid(project).await?;
        Ok(json!(self.read_sections(project).await?))
    }

    // Writing.

    /// Keeps a doc's title and text as they now are, or, with `deleted`, as they were when it went, and where it was filed.
    async fn keep_revision(&mut self, project: &str, doc: (&str, &str, &str, &str), actor: &Actor, deleted: Option<Option<String>>) -> Result<()> {
        let (id, title, body, kind) = doc;
        sqlx::query(&sql("INSERT INTO doc_revisions (project, doc, title, body, kind, section, deleted, created_by, session_name, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
            .bind(project).bind(id).bind(title).bind(body).bind(kind).bind(deleted.clone().flatten()).bind(deleted.is_some() as i64)
            .bind(&actor.name).bind(actor.session.clone()).bind(actor.owner as i64).bind(stamp())
            .execute(&mut *self.conn).await?;
        Ok(())
    }

    async fn arrange_sections(&mut self, project: &str, names: &[String]) -> Result<()> {
        sqlx::query(&sql("UPDATE projects SET doc_section_order = ? WHERE id = ?"))
            .bind(serde_json::to_string(names).unwrap())
            .bind(project)
            .execute(&mut *self.conn)
            .await?;
        Ok(())
    }

    /// A new section goes at the end, so what's listed until now keeps its place, A–Z or as arranged.
    async fn section_last(&mut self, project: &str, section: Option<&str>) -> Result<()> {
        let Some(section) = section else { return Ok(()) };
        let mut sections = self.read_sections(project).await?;
        if !sections.iter().any(|s| s == section) {
            sections.push(section.into());
            self.arrange_sections(project, &sections).await?;
        }
        Ok(())
    }

    pub async fn create(&mut self, project: &str, body: &Value, actor: &Actor) -> Result<Value> {
        self.project_uid(project).await?;
        let input = check_doc_input(body, false)?;
        let title = text_of(&input, "title").unwrap_or_default().trim().to_string();
        let kind = text_of(&input, "kind").unwrap_or_else(|| "markdown".into());
        let text = text_of(&input, "body").unwrap_or_default();
        let id = match text_of(&input, "id") {
            Some(id) => {
                if self.exists("SELECT 1 FROM docs WHERE project = ? AND id = ?", project, &id).await? {
                    return Err(ApiError::conflict(format!("There is already a doc \"{id}\" in {project}")));
                }
                id
            }
            None => {
                let base = Some(slugify(&title)).filter(|s| !s.is_empty()).unwrap_or_else(|| "doc".into());
                let mut id = base.clone();
                // The number trims the name to fit, so the id stays one `PUT /docs/:id` takes (at most 40).
                let mut n = 2;
                while self.exists("SELECT 1 FROM docs WHERE project = ? AND id = ?", project, &id).await? {
                    let keep = 39usize.saturating_sub(n.to_string().len());
                    id = format!("{}-{n}", first_chars(&base, keep).trim_end_matches('-'));
                    n += 1;
                }
                id
            }
        };
        let section = section_of(input.get("section")).flatten();
        let position = input.get("position").and_then(Value::as_f64);
        let now = stamp();
        self.begin().await?;
        let done: Result<()> = async {
            self.section_last(project, section.as_deref()).await?;
            let position = match position { Some(at) => at, None => self.next_position(project).await? };
            sqlx::query(&sql("INSERT INTO docs (project, id, title, body, kind, position, section, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
                .bind(project).bind(&id).bind(&title).bind(&text).bind(&kind).bind(position).bind(section.clone()).bind(&actor.name).bind(actor.owner as i64).bind(&now).bind(&now)
                .execute(&mut *self.conn).await?;
            self.keep_revision(project, (&id, &title, &text, &kind), actor, None).await?;
            self.touch_project(project).await
        }.await;
        self.changed(project);
        self.effects.tell("doc.created", project, &id);
        self.finish(done).await?;
        self.doc(project, &id).await
    }

    /// Creates the doc at `id` or replaces its title and text: how a repo's Markdown file is kept in sync. True: made.
    pub async fn put(&mut self, project: &str, sent: &str, body: &Value, actor: &Actor) -> Result<(Value, bool)> {
        self.project_uid(project).await?;
        let id = self.doc_id(project, sent).await?;
        if !is_slug(&id) {
            return Err(ApiError::bad_request(format!("\"{id}\" isn't a doc id; use lowercase letters, digits and dashes")));
        }
        let mut input = check_doc_input(body, false)?;
        if let Some(given) = text_of(&input, "id").filter(|given| *given != id) {
            return Err(ApiError::bad_request(format!("The body's id \"{given}\" isn't the URL's \"{id}\"")));
        }
        let there = self.exists("SELECT 1 FROM docs WHERE project = ? AND id = ?", project, &id).await?;
        // Another board's full id isn't a new doc to make here.
        if looks_full_doc(&id) && !there {
            return Err(ApiError::not_found(format!("No doc \"{id}\" on {project}")));
        }
        if !there {
            input.insert("id".into(), json!(id));
            return Ok((self.create(project, &Value::Object(input), actor).await?, true));
        }
        // A section left out keeps the one it has, so a repo's file synced in doesn't take it out of its group.
        let mut change = Map::new();
        for key in ["title", "position", "section", "kind"] {
            if let Some(value) = input.get(key) {
                change.insert(key.into(), value.clone());
            }
        }
        change.insert("body".into(), input.get("body").cloned().unwrap_or_else(|| json!("")));
        Ok((self.update(project, &id, &Value::Object(change), actor).await?, false))
    }

    pub async fn update(&mut self, project: &str, sent: &str, body: &Value, actor: &Actor) -> Result<Value> {
        let id = self.doc_id(project, sent).await?;
        let was = self.doc_row(project, &id).await?;
        let input = check_doc_input(body, true)?;
        if text_of(&input, "id").is_some_and(|given| given != id) {
            return Err(ApiError::bad_request("A doc's id can't change"));
        }
        if text_of(&input, "kind").is_some_and(|kind| kind != was.kind) {
            return Err(ApiError::bad_request("A doc's kind can't change: make a new one"));
        }
        let title = text_of(&input, "title").map(|t| t.trim().to_string());
        let text = text_of(&input, "body");
        let position = input.get("position").and_then(Value::as_f64);
        let section = section_of(input.get("section"));
        self.begin().await?;
        let done: Result<()> = async {
            let then = self.doc_row(project, &id).await?;
            if title.is_some() || text.is_some() || position.is_some() {
                let mut sets = vec![];
                if title.is_some() {
                    sets.push("title = ?")
                }
                if text.is_some() {
                    sets.push("body = ?")
                }
                if position.is_some() {
                    sets.push("position = ?")
                }
                sets.push("updated_at = ?");
                let statement = sql(&format!("UPDATE docs SET {} WHERE project = ? AND id = ?", sets.join(", ")));
                let mut query = sqlx::query(&statement);
                if let Some(title) = &title {
                    query = query.bind(title.clone())
                }
                if let Some(text) = &text {
                    query = query.bind(text.clone())
                }
                if let Some(position) = position {
                    query = query.bind(position)
                }
                query.bind(stamp()).bind(project).bind(&id).execute(&mut *self.conn).await?;
            }
            // Only actor change to its title or text is actor revision: not actor move, actor new position, or the same text saved again.
            let now = self.doc_row(project, &id).await?;
            if now.title != then.title || now.body != then.body {
                self.keep_revision(project, (&now.id, &now.title, &now.body, &now.kind), actor, None).await?;
            }
            // Filing it elsewhere isn't actor change to read, so it doesn't count as one (`updated_at`, what's unseen).
            if let Some(section) = &section {
                self.section_last(project, section.as_deref()).await?;
                sqlx::query(&sql("UPDATE docs SET section = ? WHERE project = ? AND id = ?"))
                    .bind(section.clone())
                    .bind(project)
                    .bind(&id)
                    .execute(&mut *self.conn)
                    .await?;
            }
            self.touch_project(project).await
        }
        .await;
        self.changed(project);
        if input.contains_key("title") || input.contains_key("body") {
            self.effects.tell("doc.changed", project, &id);
        }
        self.finish(done).await?;
        self.doc(project, &id).await
    }

    pub async fn delete(&mut self, project: &str, sent: &str, actor: &Actor) -> Result<()> {
        let id = self.doc_id(project, sent).await?;
        let row = self.doc_row(project, &id).await?;
        if row.owned != 0 && !actor.owner {
            return Err(ApiError::refused_for("issues.delete", format!("Deleting doc \"{id}\" is the owner's call: doc \"{id}\" was made by the owner")));
        }
        self.begin().await?;
        let done: Result<()> = async {
            self.keep_revision(project, (&row.id, &row.title, &row.body, &row.kind), actor, Some(row.section.clone())).await?;
            sqlx::query(&sql("DELETE FROM docs WHERE project = ? AND id = ?")).bind(project).bind(&row.id).execute(&mut *self.conn).await?;
            self.touch_project(project).await
        }
        .await;
        self.changed(project);
        self.effects.tell("doc.deleted", project, &id);
        self.finish(done).await?;
        Ok(())
    }

    /// Puts a revision's title and text back, as a new revision so it can be undone too. On a deleted doc, it comes back
    /// where it was filed and with who made it, so one the owner made stays theirs. True: it came back.
    pub async fn restore(&mut self, project: &str, sent: &str, revision: &str, actor: &Actor) -> Result<(Value, bool)> {
        let row = self.revision_row(project, sent, revision).await?;
        let (id, title, body, kind) = (row.doc.clone(), row.title.clone(), row.body.clone().unwrap_or_default(), row.kind.clone());
        if let Some(live) = self.find_doc(project, &id).await? {
            if live.kind != kind {
                return Err(ApiError::conflict(format!("Revision {revision} isn't the same kind of doc as \"{id}\" is now")));
            }
            if live.title == title && live.body == body {
                return Ok((self.doc(project, &id).await?, false));
            }
            return Ok((self.update(project, &id, &json!({"title": title, "body": body}), actor).await?, false));
        }
        self.begin().await?;
        let done: Result<()> = async {
            let each = format!("SELECT {REVISION_COLUMNS} FROM doc_revisions WHERE project = ? AND doc = ? ORDER BY id");
            let first = RevisionRow::of(&sqlx::query(&sql(&format!("{each} LIMIT 1"))).bind(project).bind(&id).fetch_one(&mut *self.conn).await?);
            let last = RevisionRow::of(&sqlx::query(&sql(&format!("{each} DESC LIMIT 1"))).bind(project).bind(&id).fetch_one(&mut *self.conn).await?);
            self.section_last(project, last.section.as_deref()).await?;
            let position = self.next_position(project).await?;
            sqlx::query(&sql("INSERT INTO docs (project, id, title, body, kind, position, section, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
                .bind(project).bind(&id).bind(&title).bind(&body).bind(&kind).bind(position).bind(last.section.clone())
                .bind(&first.created_by).bind(first.owned).bind(&first.created_at).bind(stamp())
                .execute(&mut *self.conn).await?;
            self.keep_revision(project, (&id, &title, &body, &kind), actor, None).await?;
            self.touch_project(project).await
        }.await;
        self.changed(project);
        self.effects.tell("doc.created", project, &id);
        self.finish(done).await?;
        Ok((self.doc(project, &id).await?, true))
    }

    /// Makes a section with no docs in it yet, kept until it's deleted (ORR-560).
    pub async fn create_section(&mut self, project: &str, body: &Value) -> Result<String> {
        self.project_uid(project).await?;
        let name = section_name(body)?;
        if self.read_sections(project).await?.contains(&name) {
            return Err(ApiError::conflict(format!("There is already a section \"{name}\" in {project}")));
        }
        self.begin().await?;
        let done: Result<()> = async {
            self.section_last(project, Some(&name)).await?;
            sqlx::query(&sql("INSERT INTO doc_sections (project, name, created_at) VALUES (?, ?, ?)"))
                .bind(project)
                .bind(&name)
                .bind(stamp())
                .execute(&mut *self.conn)
                .await?;
            self.touch_project(project).await
        }
        .await;
        self.changed(project);
        self.finish(done).await?;
        Ok(name)
    }

    async fn section_there(&mut self, project: &str, name: &str) -> Result<()> {
        self.project_uid(project).await?;
        if !self.read_sections(project).await?.iter().any(|s| s == name) {
            return Err(ApiError::not_found(format!("No section \"{name}\" in {project}")));
        }
        Ok(())
    }

    /// Renames a section on every doc in it at once. Like moving a doc, it doesn't count as a change to them.
    async fn rename_section(&mut self, project: &str, from: &str, body: &Value) -> Result<String> {
        self.section_there(project, from).await?;
        let name = section_name(body)?;
        if name == from {
            return Ok(name);
        }
        if self.read_sections(project).await?.contains(&name) {
            return Err(ApiError::conflict(format!("There is already a section \"{name}\" in {project}; move its docs there instead")));
        }
        self.begin().await?;
        let done: Result<()> = async {
            let renamed: Vec<String> = self.read_sections(project).await?.into_iter().map(|each| if each == from { name.clone() } else { each }).collect();
            self.arrange_sections(project, &renamed).await?;
            sqlx::query(&sql("UPDATE docs SET section = ? WHERE project = ? AND section = ?"))
                .bind(&name)
                .bind(project)
                .bind(from)
                .execute(&mut *self.conn)
                .await?;
            sqlx::query(&sql("UPDATE doc_sections SET name = ? WHERE project = ? AND name = ?"))
                .bind(&name)
                .bind(project)
                .bind(from)
                .execute(&mut *self.conn)
                .await?;
            self.touch_project(project).await
        }
        .await;
        self.changed(project);
        self.finish(done).await?;
        Ok(name)
    }

    /// Changes a section: `name` renames it, and `position` moves it in the list, 0 the top (ORR-767).
    pub async fn update_section(&mut self, project: &str, section: &str, body: &Value) -> Result<String> {
        let position = body.as_object().and_then(|o| o.get("position"));
        let at = match position {
            None => None,
            Some(value) => Some(
                value
                    .as_f64()
                    .filter(|n| n.fract() == 0.0 && *n >= 0.0)
                    .ok_or_else(|| ApiError::bad_request("A section's position is a whole number, 0 the top"))? as usize,
            ),
        };
        let renames = body.as_object().is_some_and(|o| o.contains_key("name"));
        let name = if at.is_none() || renames { self.rename_section(project, section, body).await? } else { section.to_string() };
        let Some(at) = at else { return Ok(name) };
        self.section_there(project, &name).await?;
        self.begin().await?;
        let done: Result<()> = async {
            let mut others: Vec<String> = self.read_sections(project).await?.into_iter().filter(|each| *each != *name).collect();
            others.insert(at.min(others.len()), name.clone());
            self.arrange_sections(project, &others).await?;
            self.touch_project(project).await
        }
        .await;
        self.changed(project);
        self.finish(done).await?;
        Ok(name)
    }

    /// Deletes a section, keeping its docs: they're filed under none.
    pub async fn delete_section(&mut self, project: &str, name: &str) -> Result<()> {
        self.section_there(project, name).await?;
        self.begin().await?;
        let done: Result<()> = async {
            let kept: Vec<String> = self.read_sections(project).await?.into_iter().filter(|each| *each != name).collect();
            self.arrange_sections(project, &kept).await?;
            sqlx::query(&sql("UPDATE docs SET section = NULL WHERE project = ? AND section = ?")).bind(project).bind(name).execute(&mut *self.conn).await?;
            sqlx::query(&sql("DELETE FROM doc_sections WHERE project = ? AND name = ?")).bind(project).bind(name).execute(&mut *self.conn).await?;
            self.touch_project(project).await
        }
        .await;
        self.changed(project);
        self.finish(done).await?;
        Ok(())
    }
}
