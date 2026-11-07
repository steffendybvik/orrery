// Epics (ORR-1004): what `epics`, `epic`, `createEpic`, `updateEpic` and `deleteEpic` in web/server/store/epics.ts do,
// on the same tables, answering as `GET` and `POST /api/epics` and `GET`, `PATCH` and `DELETE /api/epics/{epic}` do. An
// epic is one piece of work across projects (ORR-895), with a number of its own across the orrery; its progress is its
// issues', counted the way a release's are, from each project's board as `issues.rs` reads it. A write says the epics
// changed (`Effects::epics`), for open pages to ask for them again. An epic's focus signals sessions, so it stays in Nuxt.
use crate::board::issue_edits::epic_number;
use crate::board::issues::{kinds_json, Board, Issues, Kinds, Node};
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::work::settings::Settings;
use crate::write::{js, stamp, Actor, Effects};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::collections::HashMap;

/// What an epic's body may hold (`EPIC_FIELDS`).
const FIELDS: [&str; 3] = ["title", "notes", "position"];

const COLUMNS: &str = "CAST(id AS BIGINT) AS id, title, notes, created_by, CAST(owned AS BIGINT) AS owned, created_at, updated_at";

/// An epic's body as `checkInput` takes it against `EPIC_FIELDS`: `title` a string that isn't blank (needed unless
/// `partial`), `notes` a string or null, `position` a number.
fn check_input(body: &Value, partial: bool) -> Result<Map<String, Value>> {
    let Some(sent) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
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
            if key == "notes" {
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

/// An epic's own fields (`epicOf`): `notes` only when it has some.
fn epic_of(row: &AnyRow) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(row.get::<i64, _>("id")));
    out.insert("title".into(), json!(row.get::<String, _>("title")));
    if let Some(notes) = row.get::<Option<String>, _>("notes").filter(|n| !n.is_empty()) {
        out.insert("notes".into(), json!(notes));
    }
    out.insert("created_by".into(), json!(row.get::<String, _>("created_by")));
    out.insert("protected".into(), json!(row.get::<i64, _>("owned") != 0));
    out.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
    out.insert("updated_at".into(), json!(row.get::<String, _>("updated_at")));
    out
}

/// An issue's epic on the board, if it has one.
fn epic_in(issue: &Node) -> Option<i64> {
    issue.fields.get("epic").and_then(Value::as_i64)
}

/// How many issues are set for an epic, and how far their leaves are.
#[derive(Default, Clone)]
struct Tally {
    issues: i64,
    kinds: Kinds,
}

/// Each of `epics`' tally across `boards` (`tallyEpics`): `issues` those set for it (a sub-issue's own when it differs
/// from its parent's), and `kinds` their leaves', a sub-issue with no epic of its own going with its parent's.
fn tally(epics: &[i64], boards: &[&Board]) -> HashMap<i64, Tally> {
    fn walk(tally: &mut HashMap<i64, Tally>, issues: &[Node], current: Option<i64>) {
        for issue in issues {
            let own = epic_in(issue);
            let epic = own.or(current);
            if let Some(own) = own.filter(|o| Some(*o) != current) {
                if let Some(t) = tally.get_mut(&own) {
                    t.issues += 1;
                }
            }
            if !issue.tasks.is_empty() {
                walk(tally, &issue.tasks, epic);
            } else if let Some(t) = epic.and_then(|e| tally.get_mut(&e)) {
                for (k, n) in t.kinds.iter_mut().zip(issue.kinds) {
                    *k += n;
                }
            }
        }
    }
    let mut out: HashMap<i64, Tally> = epics.iter().map(|e| (*e, Tally::default())).collect();
    for board in boards {
        for group in &board.milestones {
            walk(&mut out, &group.tasks, None);
        }
    }
    out
}

pub struct Epics<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Epics<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Epics { conn, effects: Effects::default(), outbox: None }
    }

    async fn uid(&mut self) -> Result<String> {
        Ok(Settings::new(&mut *self.conn).get().await?["uid"].as_str().unwrap_or_default().to_string())
    }

    /// The epic's number from its number or any form of its id, as `epicId` reads the URL, then its row (`epicRow`),
    /// 404 when there's none.
    pub async fn epic_id(&mut self, sent: &str) -> Result<i64> {
        let uid = self.uid().await?;
        let id = epic_number(sent, &uid).and_then(|n| n.parse::<i64>().ok());
        let Some(id) = id.filter(|_| !sent.trim().is_empty()) else { return Err(ApiError::not_found(format!("No epic {sent}: GET /api/epics lists them"))) };
        self.row(id).await?;
        Ok(id)
    }

    async fn row(&mut self, id: i64) -> Result<AnyRow> {
        sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM epics WHERE id = ?")))
            .bind(id)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No epic {id}: GET /api/epics lists them")))
    }

    /// The projects with an issue set for one of `epics` (every epic, without), by id (`projectsIn`).
    async fn projects_in(&mut self, epic: Option<i64>) -> Result<Vec<String>> {
        let rows = match epic {
            Some(epic) => {
                sqlx::query(&sql("SELECT DISTINCT project FROM issues WHERE epic = ? ORDER BY project")).bind(epic).fetch_all(&mut *self.conn).await?
            }
            None => sqlx::query("SELECT DISTINCT project FROM issues WHERE epic IS NOT NULL ORDER BY project").fetch_all(&mut *self.conn).await?,
        };
        Ok(rows.iter().map(|r| r.get("project")).collect())
    }

    /// Every epic, in the order they're arranged in, a new one on top, each with its progress and each project's part
    /// (`epics`).
    pub async fn list(&mut self) -> Result<Value> {
        let rows = sqlx::query(&format!("SELECT {COLUMNS} FROM epics ORDER BY position, id DESC")).fetch_all(&mut *self.conn).await?;
        let ids: Vec<i64> = rows.iter().map(|r| r.get("id")).collect();
        let projects = self.projects_in(None).await?;
        let mut issues = Issues::new(&mut *self.conn);
        let statuses = issues.statuses().await?;
        let mut boards = Vec::new();
        for project in &projects {
            boards.push(issues.board(project, &statuses).await?);
        }
        let together = tally(&ids, &boards.iter().collect::<Vec<_>>());
        let parts: Vec<HashMap<i64, Tally>> = boards.iter().map(|b| tally(&ids, &[b])).collect();
        let uid = self.uid().await?;
        Ok(Value::Array(
            rows.iter()
                .map(|row| {
                    let id: i64 = row.get("id");
                    let mut epic = epic_of(row);
                    let all = together.get(&id).cloned().unwrap_or_default();
                    epic.insert("full_id".into(), json!(format!("EPC-{id}-{uid}")));
                    epic.insert("issues".into(), json!(all.issues));
                    epic.insert("kinds".into(), kinds_json(&all.kinds));
                    let each: Vec<Value> = projects
                        .iter()
                        .zip(&parts)
                        .filter_map(|(project, part)| {
                            let part = part.get(&id).filter(|p| p.issues > 0)?;
                            Some(json!({"project": project, "issues": part.issues, "kinds": kinds_json(&part.kinds)}))
                        })
                        .collect();
                    epic.insert("projects".into(), Value::Array(each));
                    Value::Object(epic)
                })
                .collect(),
        ))
    }

    /// The epic with its issues, in a section per project: those set for it (a sub-issue's when its parent isn't),
    /// each with its sub-issues (`epic`).
    pub async fn epic(&mut self, id: i64) -> Result<Value> {
        self.row(id).await?;
        let all = self.list().await?;
        let mut epic = all.as_array().and_then(|a| a.iter().find(|e| e["id"].as_i64() == Some(id))).cloned().unwrap_or(Value::Null);
        let mut parts = Vec::new();
        for project in self.projects_in(Some(id)).await? {
            let mut issues = Issues::new(&mut *self.conn);
            let name = issues.project(&project).await?.name;
            let statuses = issues.statuses().await?;
            let board = issues.board(&project, &statuses).await?;
            fn walk(out: &mut Vec<Value>, issues: &[Node], id: i64) {
                for issue in issues {
                    if epic_in(issue) == Some(id) {
                        out.push(issue.json());
                    } else {
                        walk(out, &issue.tasks, id);
                    }
                }
            }
            let mut tasks = Vec::new();
            for group in &board.milestones {
                walk(&mut tasks, &group.tasks, id);
            }
            let part = epic["projects"].as_array().and_then(|p| p.iter().find(|e| e["project"].as_str() == Some(project.as_str()))).cloned();
            if let Some(part) = part {
                parts.push(json!({"project": project, "name": name, "issues": part["issues"], "kinds": part["kinds"], "tasks": tasks}));
            }
        }
        epic["parts"] = Value::Array(parts);
        Ok(epic)
    }

    async fn finish<T>(&mut self, done: Result<T>) -> Result<T> {
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Puts the epic at `index` among them (0 the top, past the end the bottom), numbering them all again from 0
    /// (`placeEpic`).
    async fn place(&mut self, id: i64, index: f64) -> Result<()> {
        let rows = sqlx::query("SELECT CAST(id AS BIGINT) AS id FROM epics ORDER BY position, id DESC").fetch_all(&mut *self.conn).await?;
        let mut order: Vec<i64> = rows.iter().map(|r| r.get::<i64, _>("id")).filter(|e| *e != id).collect();
        let at = (index.trunc().max(0.0) as usize).min(order.len());
        order.insert(at, id);
        for (position, each) in order.iter().enumerate() {
            sqlx::query(&sql("UPDATE epics SET position = ? WHERE id = ?")).bind(position as i64).bind(each).execute(&mut *self.conn).await?;
        }
        Ok(())
    }

    /// A new epic, `{title, notes?, position?}`, on top unless `position` says where (`createEpic`). Its number.
    pub async fn create(&mut self, body: &Value, actor: &Actor) -> Result<i64> {
        let input = check_input(body, false)?;
        let title = input["title"].as_str().unwrap_or_default().trim().to_string();
        let notes = input.get("notes").and_then(Value::as_str).map(str::to_string);
        let now = stamp();
        changes::begin(self.conn).await?;
        let done: Result<i64> = async {
            let top: Option<i64> = sqlx::query("SELECT CAST(min(position) AS BIGINT) AS n FROM epics").fetch_one(&mut *self.conn).await?.get("n");
            let row = sqlx::query(&sql(
                "INSERT INTO epics (title, notes, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS BIGINT) AS id",
            ))
            .bind(&title)
            .bind(notes)
            .bind(top.unwrap_or(0) - 1)
            .bind(&actor.name)
            .bind(i32::from(actor.owner))
            .bind(&now)
            .bind(&now)
            .fetch_one(&mut *self.conn)
            .await?;
            let id: i64 = row.get("id");
            if let Some(at) = input.get("position").and_then(Value::as_f64) {
                self.place(id, at).await?;
            }
            self.effects.epics = true;
            Ok(id)
        }
        .await;
        self.finish(done).await
    }

    /// Changes its title, notes or place among them (`updateEpic`). A new title or notes is `epic.changed` on each
    /// project with an issue in it (ORR-984), so the sessions on them hear it; moving it says nothing.
    pub async fn update(&mut self, id: i64, body: &Value) -> Result<()> {
        let before = self.row(id).await?;
        let input = check_input(body, true)?;
        let title = input.get("title").and_then(Value::as_str).map(|t| t.trim().to_string());
        let notes = input.get("notes").map(|n| n.as_str().map(str::to_string));
        let reworded = title.as_ref().is_some_and(|t| *t != before.get::<String, _>("title"))
            || notes.as_ref().is_some_and(|n| *n != before.get::<Option<String>, _>("notes"));
        let projects = if reworded { self.projects_in(Some(id)).await? } else { vec![] };
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let mut sets = vec![];
            if title.is_some() {
                sets.push("title = ?");
            }
            if notes.is_some() {
                sets.push("notes = ?");
            }
            sets.push("updated_at = ?");
            let statement = sql(&format!("UPDATE epics SET {} WHERE id = ?", sets.join(", ")));
            let mut query = sqlx::query(&statement);
            if let Some(title) = &title {
                query = query.bind(title.clone());
            }
            if let Some(notes) = &notes {
                query = query.bind(notes.clone());
            }
            query.bind(stamp()).bind(id).execute(&mut *self.conn).await?;
            if let Some(at) = input.get("position").and_then(Value::as_f64) {
                self.place(id, at).await?;
            }
            for project in &projects {
                self.effects.tell("epic.changed", project, &id.to_string());
            }
            self.effects.epics = true;
            Ok(())
        }
        .await;
        self.finish(done).await
    }

    /// Deletes it (`deleteEpic`): its issues stay where they are, in no epic, each told as `issue.epic` (ORR-984). The
    /// owner's own epic is theirs to delete.
    pub async fn delete(&mut self, id: i64, actor: &Actor) -> Result<()> {
        let row = self.row(id).await?;
        if row.get::<i64, _>("owned") != 0 && !actor.owner {
            return Err(ApiError::refused_for("epics.delete", format!("Deleting epic {id} is the owner's call: they made it")));
        }
        let projects = self.projects_in(Some(id)).await?;
        let issues = sqlx::query(&sql("SELECT project, id FROM issues WHERE epic = ? ORDER BY project, id")).bind(id).fetch_all(&mut *self.conn).await?;
        let issues: Vec<(String, String)> = issues.iter().map(|r| (r.get("project"), r.get("id"))).collect();
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql("UPDATE issues SET epic = NULL WHERE epic = ?")).bind(id).execute(&mut *self.conn).await?;
            for (project, issue) in &issues {
                self.effects.tell_change("issue.epic", project, issue, Some(&id.to_string()), None);
            }
            sqlx::query(&sql("DELETE FROM epics WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
            let now = stamp();
            for project in &projects {
                sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(&now).bind(project).execute(&mut *self.conn).await?;
            }
            self.effects.changed = projects.clone();
            self.effects.epics = true;
            Ok(())
        }
        .await;
        self.finish(done).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_an_epic_as_check_input_does() {
        assert!(check_input(&json!({"title": "  Gears  ", "notes": null, "position": 1}), false).is_ok());
        assert!(check_input(&json!({"notes": "x"}), true).is_ok());
        assert!(check_input(&json!({"title": " "}), false).is_err());
        assert!(check_input(&json!({"bogus": 1}), true).is_err());
        assert!(check_input(&json!([]), true).is_err());
    }
}
