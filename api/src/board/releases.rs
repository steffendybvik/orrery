// A project's releases, written (ORR-974): what `createRelease`, `updateRelease` and `deleteRelease` do
// (web/server/store/releases.ts), answering as their routes do. Reading them is `plans.rs`. Each write puts what it set
// off in the outbox inside its transaction (ORR-929), and the router tells the Nuxt server's hooks from the reply.
use crate::board::issues::Issues;
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{js, stamp, Actor, Effects};
use regex::Regex;
use serde_json::{Map, Value};
use sqlx::{AnyConnection, Row};
use std::sync::LazyLock;

/// `RELEASE_FIELDS`, in its order, as problems are listed in it.
const FIELDS: [&str; 6] = ["position", "version", "branch", "notes", "frozen_on", "shipped_on"];
static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$").expect("the version pattern"));
static DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("the day pattern"));

/// A body as `checkInput(body, RELEASE_FIELDS, partial)` takes it: `version` is required unless `partial`; `branch`,
/// `notes` and the two days may be null.
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
            if !partial && key == "version" {
                problems.push("missing \"version\"".into());
            }
            continue;
        };
        if value.is_null() {
            if key == "position" || key == "version" {
                problems.push(format!("\"{key}\" can't be null"));
            } else {
                input.insert(key.into(), Value::Null);
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
        let pattern = match key {
            "version" => Some((&*VERSION, "use letters, digits, dots and dashes, e.g. 1.0.0-rc.2")),
            "frozen_on" | "shipped_on" => Some((&*DAY, "use a day, YYYY-MM-DD")),
            _ => None,
        };
        if let Some((pattern, hint)) = pattern {
            if !pattern.is_match(text) {
                problems.push(format!("\"{key}\" is \"{text}\"; {hint}"));
                continue;
            }
        }
        input.insert(key.into(), value.clone());
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(input)
}

/// A nullable text field as sent: absent, null or the text.
fn text(input: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    input.get(key).map(|v| v.as_str().map(str::to_string))
}

/// A branch as kept: trimmed, and none when that leaves nothing.
fn branch_of(sent: Option<String>) -> Option<String> {
    sent.map(|b| b.trim().to_string()).filter(|b| !b.is_empty())
}

/// What `deleteRelease` and `updateRelease` read of the release before changing it.
struct Before {
    frozen: bool,
    shipped: bool,
    owned: bool,
}

pub struct Releases<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Releases<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Releases { conn, effects: Effects::default(), outbox: None }
    }

    /// Refuses changing a release from a project that has none, or takes them from another (`ownReleases`).
    async fn own_releases(&mut self, project: &str, action: &str) -> Result<()> {
        let row = Issues::new(self.conn).project(project).await?;
        let source = match row.release_mode.as_str() {
            "shared" => row.releases_from,
            "own" => Some(project.to_string()),
            _ => None,
        };
        match source {
            None => {
                Err(ApiError::bad_request(format!("{project} has no releases; turn them on with PATCH /api/projects/{project} {{\"release_mode\": \"own\"}}")))
            }
            Some(source) if source != project => {
                Err(ApiError::bad_request(format!("{project} takes its releases from {source}; {action} there: /api/projects/{source}/releases")))
            }
            Some(_) => Ok(()),
        }
    }

    /// The release as it is, or a 404 as `releaseRow` gives it.
    async fn before(&mut self, project: &str, version: &str) -> Result<Before> {
        let row = Issues::new(self.conn).project(project).await?;
        Issues::new(self.conn).release_there(project, &row, version).await?;
        let row = sqlx::query(&sql("SELECT frozen_on, shipped_on, CAST(owned AS BIGINT) AS owned FROM releases WHERE project = ? AND version = ?"))
            .bind(project)
            .bind(version)
            .fetch_one(&mut *self.conn)
            .await?;
        Ok(Before {
            frozen: row.get::<Option<String>, _>("frozen_on").is_some_and(|d| !d.is_empty()),
            shipped: row.get::<Option<String>, _>("shipped_on").is_some_and(|d| !d.is_empty()),
            owned: row.get::<i64, _>("owned") != 0,
        })
    }

    async fn touch_project(&mut self, project: &str) -> Result<()> {
        sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(stamp()).bind(project).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// The newest doc revision on this orrery, 0 with none yet (`docMark`): shipping marks the docs as they are.
    async fn doc_mark(&mut self) -> Result<i64> {
        let row = sqlx::query("SELECT CAST(max(id) AS BIGINT) AS n FROM doc_revisions").fetch_one(&mut *self.conn).await?;
        Ok(row.get::<Option<i64>, _>("n").unwrap_or(0))
    }

    /// Puts the release at `index` among the project's releases, 0 the top and past the end the bottom, numbering them
    /// all again from 0 (`placeRelease`).
    async fn place(&mut self, project: &str, version: &str, index: f64) -> Result<()> {
        let rows = sqlx::query(&sql("SELECT version FROM releases WHERE project = ? ORDER BY position, created_at DESC"))
            .bind(project)
            .fetch_all(&mut *self.conn)
            .await?;
        let mut order: Vec<String> = rows.iter().map(|r| r.get::<String, _>("version")).filter(|v| v != version).collect();
        let at = (index.trunc().max(0.0) as usize).min(order.len());
        order.insert(at, version.to_string());
        for (position, each) in order.iter().enumerate() {
            sqlx::query(&sql("UPDATE releases SET position = ? WHERE project = ? AND version = ?"))
                .bind(position as i64)
                .bind(project)
                .bind(each)
                .execute(&mut *self.conn)
                .await?;
        }
        Ok(())
    }

    async fn finish<T>(&mut self, done: Result<T>) -> Result<T> {
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Checks a release as making it (no `version`) or changing release `version` would, saving nothing
    /// (`checkRelease`): when it's a change, the release's fields as they are, with `position` its place among the
    /// project's, 0 the top. The owner's chat asks before it makes or changes one (ORR-504, ORR-1100).
    pub async fn check(&mut self, project: &str, body: &Value, version: Option<&str>) -> Result<Option<Map<String, Value>>> {
        self.own_releases(project, if version.is_none() { "make them" } else { "change them" }).await?;
        let input = check_input(body, version.is_some())?;
        let Some(version) = version else {
            let wanted = input["version"].as_str().unwrap_or_default();
            let taken = sqlx::query(&sql("SELECT 1 FROM releases WHERE project = ? AND version = ?"))
                .bind(project)
                .bind(wanted)
                .fetch_optional(&mut *self.conn)
                .await?;
            if taken.is_some() {
                return Err(ApiError::conflict(format!("There is already a release {wanted} in {project}")));
            }
            return Ok(None);
        };
        self.before(project, version).await?;
        if input.get("version").is_some_and(|v| v.as_str() != Some(version)) {
            return Err(ApiError::bad_request("A release's version can't change: make one with the new version and move its issues to it"));
        }
        let rows = sqlx::query(&sql("SELECT version, branch, notes, frozen_on, shipped_on FROM releases WHERE project = ? ORDER BY position, created_at DESC"))
            .bind(project)
            .fetch_all(&mut *self.conn)
            .await?;
        let Some(at) = rows.iter().position(|r| r.get::<String, _>("version") == version) else {
            return Err(ApiError::not_found(format!("No release {version} in {project}")));
        };
        let mut current = Map::new();
        current.insert("position".into(), Value::from(at));
        for key in ["version", "branch", "notes", "frozen_on", "shipped_on"] {
            current.insert(key.into(), rows[at].get::<Option<String>, _>(key).map_or(Value::Null, Value::from));
        }
        Ok(Some(current))
    }

    /// Makes a release at the top of the project's: its version.
    pub async fn create(&mut self, project: &str, body: &Value, actor: &Actor) -> Result<String> {
        self.own_releases(project, "make them").await?;
        let input = check_input(body, false)?;
        let version = input["version"].as_str().unwrap_or_default().to_string();
        let taken =
            sqlx::query(&sql("SELECT 1 FROM releases WHERE project = ? AND version = ?")).bind(project).bind(&version).fetch_optional(&mut *self.conn).await?;
        if taken.is_some() {
            return Err(ApiError::conflict(format!("There is already a release {version} in {project}")));
        }
        let now = stamp();
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let top = sqlx::query(&sql("SELECT CAST(min(position) AS BIGINT) AS n FROM releases WHERE project = ?"))
                .bind(project)
                .fetch_one(&mut *self.conn)
                .await?
                .get::<Option<i64>, _>("n")
                .unwrap_or(0);
            let shipped_on = text(&input, "shipped_on").flatten();
            let doc_mark = match shipped_on {
                Some(_) => Some(self.doc_mark().await?),
                None => None,
            };
            sqlx::query(&sql("INSERT INTO releases (project, version, branch, notes, frozen_on, shipped_on, doc_mark, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
                .bind(project)
                .bind(&version)
                .bind(branch_of(text(&input, "branch").flatten()))
                .bind(text(&input, "notes").flatten())
                .bind(text(&input, "frozen_on").flatten())
                .bind(shipped_on)
                .bind(doc_mark)
                .bind(top - 1)
                .bind(&actor.name)
                .bind(i32::from(actor.owner))
                .bind(&now)
                .bind(&now)
                .execute(&mut *self.conn)
                .await?;
            if let Some(at) = input.get("position").and_then(Value::as_f64) {
                self.place(project, &version, at).await?;
            }
            self.touch_project(project).await?;
            self.effects.changed = vec![project.into()];
            self.effects.tell("release.created", project, &version);
            Ok(())
        }
        .await;
        self.finish(done).await?;
        Ok(version)
    }

    /// Changes its branch, notes, days or place. Setting a day freezes or ships it, clearing one thaws or unships it,
    /// each told; a new day on one already set is no event.
    pub async fn update(&mut self, project: &str, version: &str, body: &Value) -> Result<()> {
        self.own_releases(project, "change them").await?;
        let before = self.before(project, version).await?;
        let input = check_input(body, true)?;
        if input.get("version").is_some_and(|v| v.as_str() != Some(version)) {
            return Err(ApiError::bad_request("A release's version can't change: make one with the new version and move its issues to it"));
        }
        let set = |key: &str| input.get(key).map(|v| v.as_str().is_some_and(|d| !d.is_empty()));
        let (frozen, shipped) = (set("frozen_on"), set("shipped_on"));
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            // Shipping marks the docs as they are now, and shipping it again marks them anew: un-shipping lets go of the
            // old mark, as what ships next isn't what shipped then. A new day on one already shipped keeps it.
            let doc_mark = match shipped {
                Some(now) if now != before.shipped => Some(if now { Some(self.doc_mark().await?) } else { None }),
                _ => None,
            };
            let mut sets = vec![];
            for key in ["branch", "notes", "frozen_on", "shipped_on"] {
                if input.contains_key(key) {
                    sets.push(format!("{key} = ?"));
                }
            }
            if doc_mark.is_some() {
                sets.push("doc_mark = ?".into());
            }
            sets.push("updated_at = ?".into());
            let statement = sql(&format!("UPDATE releases SET {} WHERE project = ? AND version = ?", sets.join(", ")));
            let mut query = sqlx::query(&statement);
            for key in ["branch", "notes", "frozen_on", "shipped_on"] {
                if let Some(value) = text(&input, key) {
                    query = query.bind(if key == "branch" { branch_of(value) } else { value });
                }
            }
            if let Some(mark) = doc_mark {
                query = query.bind(mark);
            }
            query.bind(stamp()).bind(project).bind(version).execute(&mut *self.conn).await?;
            if let Some(at) = input.get("position").and_then(Value::as_f64) {
                self.place(project, version, at).await?;
            }
            self.touch_project(project).await?;
            self.effects.changed = vec![project.into()];
            for (now, was, on, off) in [(frozen, before.frozen, "frozen", "thawed"), (shipped, before.shipped, "shipped", "unshipped")] {
                if let Some(now) = now.filter(|now| *now != was) {
                    self.effects.tell(&format!("release.{}", if now { on } else { off }), project, version);
                }
            }
            Ok(())
        }
        .await;
        self.finish(done).await
    }

    /// Deletes it; its issues stay, set for no release, in every project drawing on it too. One the owner made is
    /// theirs to delete.
    pub async fn delete(&mut self, project: &str, version: &str, actor: &Actor) -> Result<()> {
        self.own_releases(project, "delete them").await?;
        let before = self.before(project, version).await?;
        if before.owned && !actor.owner {
            return Err(ApiError::refused_for(
                "issues.delete",
                format!("Deleting release {version} is the owner's call: release {version} was made by the owner"),
            ));
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql(
                "UPDATE issues SET ships_in = NULL WHERE (project = ? OR project IN (SELECT id FROM projects WHERE releases_from = ?)) AND ships_in = ?",
            ))
            .bind(project)
            .bind(project)
            .bind(version)
            .execute(&mut *self.conn)
            .await?;
            sqlx::query(&sql("DELETE FROM releases WHERE project = ? AND version = ?")).bind(project).bind(version).execute(&mut *self.conn).await?;
            self.touch_project(project).await?;
            self.effects.changed = vec![project.into()];
            self.effects.tell("release.deleted", project, version);
            Ok(())
        }
        .await;
        self.finish(done).await
    }
}

#[cfg(test)]
#[path = "releases_tests.rs"]
mod tests;
