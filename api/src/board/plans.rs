// A project's milestones and releases, reading them (ORR-926): what `listMilestones`, `milestone`, `listReleases`,
// `release` and `allReleases` do (web/server/store/milestones.ts, releases.ts), answering as their `GET` routes do. Each
// is worked out from the board as `issues.rs` reads it, as the store works them out from `readBoard`'s. Writing them
// is `milestones.rs` and `releases.rs` (ORR-974).
use crate::board::issues::{kinds_json, Board, Issues, Kinds, Node, Project, Status};
use crate::db::sql;
use crate::error::{ApiError, Result};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::Row;
use std::collections::HashMap;

/// How many issues are set for a release, and how far their leaves are (`tallyReleases`).
#[derive(Default, Clone)]
struct Tally {
    issues: i64,
    kinds: Kinds,
}

impl Tally {
    fn put(&self, into: &mut Map<String, Value>) {
        into.insert("issues".into(), json!(self.issues));
        into.insert("kinds".into(), kinds_json(&self.kinds));
    }
}

/// Each of `versions`' tally across `boards`: `issues` those set for it (a sub-issue's own when it differs from its
/// parent's), and `kinds` the leaves under them, a sub-issue with none of its own going with its parent's.
fn tally(versions: &[String], boards: &[&Board]) -> HashMap<String, Tally> {
    fn walk(tally: &mut HashMap<String, Tally>, issues: &[Node], current: Option<&str>) {
        for issue in issues {
            let own = issue.fields.get("release").and_then(Value::as_str).filter(|r| !r.is_empty());
            let release = own.or(current);
            if let Some(own) = own.filter(|o| Some(*o) != current) {
                if let Some(t) = tally.get_mut(own) {
                    t.issues += 1;
                }
            }
            if !issue.tasks.is_empty() {
                walk(tally, &issue.tasks, release);
            } else if let Some(t) = release.and_then(|r| tally.get_mut(r)) {
                for (k, n) in t.kinds.iter_mut().zip(issue.kinds) {
                    *k += n;
                }
            }
        }
    }
    let mut out: HashMap<String, Tally> = versions.iter().map(|v| (v.clone(), Tally::default())).collect();
    for board in boards {
        for group in &board.milestones {
            walk(&mut out, &group.tasks, None);
        }
    }
    out
}

/// A release's row as it's handed out (`releaseOf`), without `notes` when `notes` is false.
fn release_of(row: &AnyRow, notes: bool) -> Map<String, Value> {
    let text = |key: &str| row.get::<Option<String>, _>(key);
    let mut out = Map::new();
    out.insert("version".into(), json!(text("version").unwrap_or_default()));
    for key in ["branch", "notes", "frozen_on", "shipped_on"] {
        if let Some(value) = text(key).filter(|_| notes || key != "notes") {
            out.insert(key.into(), json!(value));
        }
    }
    if let Some(mark) = row.get::<Option<i64>, _>("doc_mark") {
        out.insert("doc_mark".into(), json!(mark));
    }
    out.insert("created_by".into(), json!(text("created_by").unwrap_or_default()));
    out.insert("protected".into(), json!(row.get::<i64, _>("owned") != 0));
    out.insert("created_at".into(), json!(text("created_at").unwrap_or_default()));
    out.insert("updated_at".into(), json!(text("updated_at").unwrap_or_default()));
    out
}

const RELEASE_COLUMNS: &str =
    "version, branch, notes, frozen_on, shipped_on, CAST(doc_mark AS BIGINT) AS doc_mark, created_by, CAST(owned AS BIGINT) AS owned, created_at, updated_at";

/// A project as reading its releases takes: its row and its board.
struct Read {
    id: String,
    row: Project,
    board: Board,
}

pub struct Plans<'c, 'i> {
    issues: &'i mut Issues<'c>,
    /// Whether only the boards' counts are wanted, so their outlines will do (ORR-1117).
    counted: bool,
}

impl<'c, 'i> Plans<'c, 'i> {
    pub fn new(issues: &'i mut Issues<'c>) -> Self {
        Plans { issues, counted: false }
    }

    /// For what only counts the boards up: a project's counts, its releases' tallies (ORR-1117).
    pub fn counting(issues: &'i mut Issues<'c>) -> Self {
        Plans { issues, counted: true }
    }

    /// The project's board, or, counting, its outline.
    async fn board_of(&mut self, project: &str, statuses: &[Status]) -> Result<Board> {
        if self.counted {
            self.issues.outline(project, statuses).await
        } else {
            self.issues.board(project, statuses).await
        }
    }

    /// The project's milestones in order, each with its column, counts and top-level issue ids (`listMilestones`).
    pub async fn milestones(&mut self, project: &str) -> Result<Value> {
        self.issues.project(project).await?;
        let statuses = self.issues.statuses().await?;
        let board = self.issues.board(project, &statuses).await?;
        Ok(Value::Array(board.milestones.iter().filter(|g| !g.id.is_empty()).map(|g| Value::Object(record(&g.fields, &g.tasks))).collect()))
    }

    /// One milestone, with its issues in full (`milestone`).
    pub async fn milestone(&mut self, project: &str, sent: &str) -> Result<Value> {
        let id = self.issues.resolve(project, sent, true).await?;
        let row = self.issues.project(project).await?;
        if !self.issues.exists("SELECT 1 FROM milestones WHERE project = ? AND id = ?", &[project, &id]).await? {
            return Err(ApiError::not_found(format!("No milestone \"{id}\" in {project}")));
        }
        let statuses = self.issues.statuses().await?;
        let board = self.issues.board(project, &statuses).await?;
        let group = board.milestones.iter().find(|g| g.id == id).ok_or_else(|| ApiError::not_found(format!("No milestone \"{id}\" in {project}")))?;
        let mut out = record(&group.fields, &group.tasks);
        out.insert("tasks".into(), Value::Array(group.tasks.iter().map(Node::json).collect()));
        out.insert("full_id".into(), json!(format!("MLS-{id}-{}", row.uid)));
        Ok(Value::Object(out))
    }

    async fn read(&mut self, project: &str, statuses: &[Status]) -> Result<Read> {
        let row = self.issues.project(project).await?;
        let board = self.board_of(project, statuses).await?;
        Ok(Read { id: project.into(), row, board })
    }

    /// The projects taking their releases from `project`, by id (`drawingOn`).
    async fn drawing_on(&mut self, project: &str) -> Result<Vec<String>> {
        let rows = sqlx::query(&sql("SELECT id FROM projects WHERE releases_from = ? ORDER BY id")).bind(project).fetch_all(&mut *self.issues.conn).await?;
        Ok(rows.iter().map(|r| r.get("id")).collect())
    }

    async fn release_rows(&mut self, source: &str) -> Result<Vec<AnyRow>> {
        Ok(sqlx::query(&sql(&format!("SELECT {RELEASE_COLUMNS} FROM releases WHERE project = ? ORDER BY position, created_at DESC")))
            .bind(source)
            .fetch_all(&mut *self.issues.conn)
            .await?)
    }

    /// The project's releases, its source's when it takes them from another, each with how far its issues are
    /// (`readReleases`): a source counts every project drawing on it, one drawing on it its own.
    async fn releases_of(&mut self, read: &Read, statuses: &[Status]) -> Result<Vec<Map<String, Value>>> {
        if read.row.release_mode == "none" {
            return Ok(Vec::new());
        }
        let rows = self.release_rows(read.row.releases_from.as_deref().unwrap_or(&read.id)).await?;
        let mut others = Vec::new();
        if read.row.releases_from.is_none() {
            for other in self.drawing_on(&read.id).await? {
                others.push(self.board_of(&other, statuses).await?);
            }
        }
        let boards: Vec<&Board> = std::iter::once(&read.board).chain(others.iter()).collect();
        let versions: Vec<String> = rows.iter().map(|r| r.get("version")).collect();
        let tally = tally(&versions, &boards);
        Ok(rows
            .iter()
            .map(|row| {
                let mut out = release_of(row, true);
                tally[&row.get::<String, _>("version")].put(&mut out);
                out
            })
            .collect())
    }

    /// The project's board and its releases, as `projectOf` reads them both (`readBoard`, `readReleases`).
    pub(crate) async fn board_and_releases(&mut self, project: &str, statuses: &[Status]) -> Result<(Board, Vec<Map<String, Value>>)> {
        let read = self.read(project, statuses).await?;
        let releases = self.releases_of(&read, statuses).await?;
        Ok((read.board, releases))
    }

    /// The project's releases, newest first, each with how far its issues are (`listReleases`).
    pub async fn releases(&mut self, project: &str) -> Result<Value> {
        self.counted = true;
        let statuses = self.issues.statuses().await?;
        let read = self.read(project, &statuses).await?;
        Ok(Value::Array(self.releases_of(&read, &statuses).await?.into_iter().map(Value::Object).collect()))
    }

    /// The release with its issues: those set for it, each with its sub-issues, as `tasks` (the project's own) and by
    /// project in `projects`, with those drawing on it when it's their source (`release`).
    pub async fn release(&mut self, project: &str, version: &str) -> Result<Value> {
        let row = self.issues.project(project).await?;
        self.issues.release_there(project, &row, version).await?;
        let statuses = self.issues.statuses().await?;
        let own = self.read(project, &statuses).await?;
        let mut drawing = Vec::new();
        if own.row.releases_from.is_none() {
            for other in self.drawing_on(project).await? {
                drawing.push(self.read(&other, &statuses).await?);
            }
        }
        let mut parts = Vec::new();
        let mut listed = None;
        for (at, read) in std::iter::once(&own).chain(drawing.iter()).enumerate() {
            let releases = self.releases_of(read, &statuses).await?;
            let found =
                releases.into_iter().find(|r| r["version"] == version).ok_or_else(|| ApiError::internal(format!("release {version} in {}", read.id)))?;
            let mut tasks = Vec::new();
            fn walk(tasks: &mut Vec<Value>, issues: &[Node], version: &str) {
                for issue in issues {
                    if issue.fields.get("release").and_then(Value::as_str) == Some(version) {
                        tasks.push(issue.json());
                    } else {
                        walk(tasks, &issue.tasks, version);
                    }
                }
            }
            for group in &read.board.milestones {
                walk(&mut tasks, &group.tasks, version);
            }
            let mut part = Map::new();
            part.insert("project".into(), json!(read.id));
            part.insert("name".into(), json!(read.row.name));
            part.insert("issues".into(), found["issues"].clone());
            part.insert("kinds".into(), found["kinds"].clone());
            part.insert("tasks".into(), Value::Array(tasks));
            // A source's own row counts every project; its part here is only its own issues.
            if at == 0 && !drawing.is_empty() {
                tally(&[version.to_string()], &[&own.board])[version].put(&mut part);
            }
            if at == 0 {
                listed = Some(found);
            }
            parts.push(part);
        }
        let mut out = listed.unwrap_or_default();
        out.insert("project".into(), json!(project));
        out.insert("tasks".into(), parts[0]["tasks"].clone());
        out.insert("projects".into(), Value::Array(parts.into_iter().map(Value::Object).collect()));
        Ok(Value::Object(out))
    }

    /// Every project with releases of its own, each with those it covers and their releases without notes, a release
    /// several projects share once, with each one's part (`allReleases`).
    pub async fn all_releases(&mut self) -> Result<Value> {
        let statuses = self.issues.statuses().await?;
        let shipping = sqlx::query("SELECT id, release_mode, releases_from FROM projects WHERE release_mode <> 'none' ORDER BY id")
            .fetch_all(&mut *self.issues.conn)
            .await?;
        let shipping: Vec<(String, String, Option<String>)> = shipping.iter().map(|r| (r.get("id"), r.get("release_mode"), r.get("releases_from"))).collect();
        let mut out = Vec::new();
        for (id, _, _) in shipping.iter().filter(|(_, mode, _)| mode == "own") {
            let projects: Vec<String> = std::iter::once(id.clone())
                .chain(shipping.iter().filter(|(_, _, from)| from.as_deref() == Some(id.as_str())).map(|(p, _, _)| p.clone()))
                .collect();
            let rows = self.release_rows(id).await?;
            let versions: Vec<String> = rows.iter().map(|r| r.get("version")).collect();
            let mut boards = Vec::new();
            for project in &projects {
                boards.push(self.issues.outline(project, &statuses).await?);
            }
            let together = tally(&versions, &boards.iter().collect::<Vec<_>>());
            let parts: Vec<HashMap<String, Tally>> = boards.iter().map(|b| tally(&versions, &[b])).collect();
            let releases: Vec<Value> = rows
                .iter()
                .map(|row| {
                    let version: String = row.get("version");
                    let mut release = release_of(row, false);
                    together[&version].put(&mut release);
                    let each: Vec<Value> = projects
                        .iter()
                        .zip(&parts)
                        .map(|(project, part)| {
                            let mut one = Map::new();
                            one.insert("project".into(), json!(project));
                            part[&version].put(&mut one);
                            Value::Object(one)
                        })
                        .collect();
                    release.insert("projects".into(), Value::Array(each));
                    Value::Object(release)
                })
                .collect();
            out.push(json!({"project": id, "projects": projects, "releases": releases}));
        }
        Ok(Value::Array(out))
    }
}

/// A milestone as it's handed out (`milestoneRecord`): its fields, and its issues by id.
fn record(fields: &Map<String, Value>, tasks: &[Node]) -> Map<String, Value> {
    let mut out = fields.clone();
    out.insert("issues".into(), json!(tasks.iter().map(Node::id).collect::<Vec<_>>()));
    out
}
