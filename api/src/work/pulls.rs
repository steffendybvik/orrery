// One pull request as orrery keeps it (ORR-952): what `forPull` in web/server/utils/pulls.ts does, on the same
// `issue_pulls` rows, answering as `GET /api/pulls/{owner}/{name}/{number}` does. The other pull reads (`GET /api/pulls`,
// `/api/pulls/branches`) ask GitHub when what's kept is stale, which is the local app's to do. Rating a PR's risk is
// written here too (ORR-952), with its outbox row (ORR-929); the poll keeping a PR stays the Nuxt server's, as a merge
// sets an issue's release and posts orrery's comments, and those writes are still Nuxt's.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::text::natural_cmp;
use crate::write::{js, Effects};
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::{AnyConnection, Row};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::LazyLock;

/// `RISK_LEVELS` in web/shared/roadmap/pulls.ts, riskiest first.
const RISK_LEVELS: [&str; 3] = ["high", "medium", "low"];
/// `LOGIN` in web/server/utils/pulls.ts: a GitHub login as it can only be.
static LOGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());

fn rank(level: Option<&str>) -> usize {
    level.and_then(|l| RISK_LEVELS.iter().position(|r| *r == l)).unwrap_or(RISK_LEVELS.len())
}

/// The pull request's number as the route reads it (`Number(n.replace(/^#/, ''))`, a whole number from 1): `788` or `#788`.
pub fn pull_number(text: &str) -> Result<i64> {
    let digits = text.strip_prefix('#').unwrap_or(text).trim();
    match digits.parse::<i64>() {
        Ok(n) if n >= 1 && !digits.starts_with('+') => Ok(n),
        _ => Err(ApiError::bad_request("Give the pull request by its number, e.g. 788")),
    }
}

/// A PR as anyone but the owner reads it (`pullForSession`, ORR-532): never its title or head branch, which an outsider
/// may have written, and its author only when it's a plain login.
fn for_session(pull: &mut Map<String, Value>) {
    pull.remove("title");
    pull.remove("branch");
    if !pull.get("author").and_then(Value::as_str).is_some_and(|a| LOGIN.is_match(a)) {
        pull.remove("author");
    }
}

/// A rating's body as the risk route checks it: `level` one of `RISK_LEVELS` or null, `why` a line (trimmed, at most
/// 300 UTF-16 units, as `slice` counts), needed with a level.
pub fn check_rating(body: &Value) -> Result<Option<(String, String)>> {
    let Some(sent) = body.as_object() else {
        return Err(ApiError::bad_request("The body should be a JSON object"));
    };
    let mut problems = vec![];
    for key in sent.keys() {
        if key != "level" && key != "why" {
            problems.push(format!("unknown field \"{key}\"; this takes level, why"));
        }
    }
    let level = match sent.get("level") {
        None => {
            problems.push("missing \"level\"".into());
            None
        }
        Some(Value::Null) => None,
        Some(Value::String(level)) if RISK_LEVELS.contains(&level.as_str()) => Some(level.clone()),
        Some(Value::String(level)) => {
            problems.push(format!("\"level\" is \"{level}\", not one of {} (or null)", RISK_LEVELS.join(", ")));
            None
        }
        Some(other) => {
            problems.push(format!("\"level\" should be a string, not {}", js(other)));
            None
        }
    };
    let why = match sent.get("why") {
        None => String::new(),
        Some(Value::String(why)) => String::from_utf16_lossy(&why.trim().encode_utf16().take(300).collect::<Vec<_>>()),
        Some(Value::Null) => {
            problems.push("\"why\" can't be null".into());
            String::new()
        }
        Some(other) => {
            problems.push(format!("\"why\" should be a string, not {}", js(other)));
            String::new()
        }
    };
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    match level {
        Some(_) if why.is_empty() => Err(ApiError::bad_request("Say why in a line, e.g. \"high: bug fix in signal routing\"")),
        Some(level) => Ok(Some((level, why))),
        None => Ok(None),
    }
}

/// A PR as the poll keeps it on its issues (`RememberedPull`), with the projects whose issues it can name.
struct Kept {
    projects: Vec<String>,
    names: Vec<String>,
    title: String,
    url: String,
    branch: String,
    base: String,
    author: String,
    merged: bool,
    closed: bool,
    merged_at: Option<String>,
    created_at: String,
    updated_at: String,
}

/// The body of `PUT /api/pulls/{owner}/{name}/{number}`: `{projects, names, title, url, branch, base, author, merged,
/// closed, merged_at, created_at, updated_at}`, each problem said.
fn check_kept(body: &Value) -> Result<Kept> {
    const FIELDS: [&str; 12] = ["projects", "names", "title", "url", "branch", "base", "author", "merged", "closed", "merged_at", "created_at", "updated_at"];
    let Some(sent) = body.as_object() else {
        return Err(ApiError::bad_request("The body should be a JSON object"));
    };
    let mut problems = vec![];
    for key in sent.keys() {
        if !FIELDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", FIELDS.join(", ")));
        }
    }
    let mut list = |key: &str| match sent.get(key) {
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect(),
        Some(other) => {
            problems.push(format!("\"{key}\" should be a list of strings, not {}", js(other)));
            vec![]
        }
        None => {
            problems.push(format!("missing \"{key}\""));
            vec![]
        }
    };
    let (projects, names) = (list("projects"), list("names"));
    let mut text = |key: &str, nullable: bool| match sent.get(key) {
        Some(Value::String(t)) => Some(t.clone()),
        Some(Value::Null) if nullable => None,
        Some(other) => {
            problems.push(format!("\"{key}\" should be a string, not {}", js(other)));
            None
        }
        None => {
            problems.push(format!("missing \"{key}\""));
            None
        }
    };
    let strings: Vec<Option<String>> = ["title", "url", "branch", "base", "author", "created_at", "updated_at"].iter().map(|k| text(k, false)).collect();
    let merged_at = text("merged_at", true);
    let mut flag = |key: &str| match sent.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(other) => {
            problems.push(format!("\"{key}\" should be true or false, not {}", js(other)));
            false
        }
        None => {
            problems.push(format!("missing \"{key}\""));
            false
        }
    };
    let (merged, closed) = (flag("merged"), flag("closed"));
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    let [title, url, branch, base, author, created_at, updated_at] =
        <[Option<String>; 7]>::try_from(strings).map_err(|_| ApiError::internal("the kept PR's fields"))?;
    let take = |v: Option<String>| v.unwrap_or_default();
    Ok(Kept {
        projects,
        names,
        title: take(title),
        url: take(url),
        branch: take(branch),
        base: take(base),
        author: take(author),
        merged,
        closed,
        merged_at,
        created_at: take(created_at),
        updated_at: take(updated_at),
    })
}

pub struct Pulls<'a> {
    conn: &'a mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'a> Pulls<'a> {
    pub fn new(conn: &'a mut AnyConnection) -> Self {
        Self { conn, effects: Effects::default(), outbox: None }
    }

    /// The issue's id from it or an old id, or a 404, as `ids` in web/server/utils/pulls.ts has it.
    async fn issue_id(&mut self, project: &str, issue: &str) -> Result<String> {
        let alias = sqlx::query(&sql("SELECT issue FROM issue_aliases WHERE project = ? AND alias = ?"))
            .bind(project)
            .bind(issue)
            .fetch_optional(&mut *self.conn)
            .await?;
        let id = alias.map(|r| r.get::<String, _>("issue")).unwrap_or_else(|| issue.to_string());
        let found = sqlx::query(&sql("SELECT 1 FROM issues WHERE project = ? AND id = ?")).bind(project).bind(&id).fetch_optional(&mut *self.conn).await?;
        if found.is_none() {
            return Err(ApiError::not_found(format!("No issue {issue} in {project}")));
        }
        Ok(id)
    }

    /// The first issue among `projects` that one of `ids` is, by its id or an old one (`issueOf`).
    async fn issue_of(&mut self, projects: &[String], ids: &[String]) -> Result<Option<(String, String)>> {
        if projects.is_empty() {
            return Ok(None);
        }
        let among = vec!["?"; projects.len()].join(", ");
        for id in ids {
            for statement in [
                format!("SELECT project, id FROM issues WHERE project IN ({among}) AND id = ?"),
                format!("SELECT i.project, i.id FROM issue_aliases a JOIN issues i ON i.project = a.project AND i.id = a.issue WHERE a.project IN ({among}) AND a.alias = ?"),
            ] {
                let statement = sql(&statement);
                let mut query = sqlx::query(&statement);
                for project in projects {
                    query = query.bind(project);
                }
                if let Some(row) = query.bind(id).fetch_optional(&mut *self.conn).await? {
                    return Ok(Some((row.get("project"), row.get("id"))));
                }
            }
        }
        Ok(None)
    }

    /// The issues in the releases of `projects` whose branch is `branch`, those of the projects sharing them included
    /// (`releaseIssues`).
    async fn release_issues(&mut self, projects: &[String], branch: &str) -> Result<Vec<(String, String)>> {
        if projects.is_empty() || branch.is_empty() {
            return Ok(vec![]);
        }
        let among = vec!["?"; projects.len()].join(", ");
        let statement = sql(&format!(
            "SELECT i.project, i.id FROM releases r JOIN issues i ON i.ships_in = r.version
                AND (i.project = r.project OR i.project IN (SELECT id FROM projects WHERE release_mode = 'shared' AND releases_from = r.project))
             WHERE r.project IN ({among}) AND r.branch = ?"
        ));
        let mut query = sqlx::query(&statement);
        for project in projects {
            query = query.bind(project);
        }
        Ok(query.bind(branch).fetch_all(&mut *self.conn).await?.iter().map(|r| (r.get("project"), r.get("id"))).collect())
    }

    /// Keeps PR `number` on `repo` on each issue it names, for good, and off any it no longer names (`remember`,
    /// ORR-795): a release PR, from a release's branch, is on every issue in that release too (ORR-913). What the local
    /// app's poll calls for each PR it reads that changed (ORR-952). It tells nobody, as the store's doesn't: what a PR
    /// does next is the poll's news, told on its own.
    pub async fn remember(&mut self, repo: &str, number: i64, body: &Value) -> Result<()> {
        let pull = check_kept(body)?;
        let mut issues: Vec<(String, String)> = vec![];
        for name in &pull.names {
            if let Some(issue) = self.issue_of(&pull.projects, std::slice::from_ref(name)).await? {
                if !issues.contains(&issue) {
                    issues.push(issue);
                }
            }
        }
        for issue in self.release_issues(&pull.projects, &pull.branch).await? {
            if !issues.contains(&issue) {
                issues.push(issue);
            }
        }
        let state = if pull.merged {
            "merged"
        } else if pull.closed {
            "closed"
        } else {
            "open"
        };
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let rows = sqlx::query(&sql("SELECT project, issue FROM issue_pulls WHERE repo = ? AND number = ?")).bind(repo).bind(number).fetch_all(&mut *self.conn).await?;
            for row in rows {
                let on: (String, String) = (row.get("project"), row.get("issue"));
                if !issues.contains(&on) {
                    sqlx::query(&sql("DELETE FROM issue_pulls WHERE project = ? AND issue = ? AND repo = ? AND number = ?"))
                        .bind(&on.0)
                        .bind(&on.1)
                        .bind(repo)
                        .bind(number)
                        .execute(&mut *self.conn)
                        .await?;
                }
            }
            for (project, id) in &issues {
                sqlx::query(&sql("INSERT INTO issue_pulls (project, issue, repo, number, title, url, branch, base, author, state, merged_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (project, issue, repo, number) DO UPDATE SET title = excluded.title, url = excluded.url, branch = excluded.branch, base = excluded.base, author = excluded.author,
                    state = excluded.state, merged_at = excluded.merged_at, updated_at = excluded.updated_at"))
                    .bind(project)
                    .bind(id)
                    .bind(repo)
                    .bind(number)
                    .bind(&pull.title)
                    .bind(&pull.url)
                    .bind(&pull.branch)
                    .bind(&pull.base)
                    .bind(&pull.author)
                    .bind(state)
                    .bind(&pull.merged_at)
                    .bind(&pull.created_at)
                    .bind(&pull.updated_at)
                    .execute(&mut *self.conn)
                    .await?;
            }
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Rates the issue's PR `number` on `repo` (`rate`, ORR-879), or takes the rating away with none: `{risk}`. The
    /// owner's rating stands, as a session's doesn't replace it (409); 404 when orrery keeps no such PR on the issue.
    pub async fn rate(&mut self, project: &str, issue: &str, repo: &str, number: i64, risk: Option<(String, String)>, owner: bool) -> Result<Value> {
        let found = sqlx::query(&sql("SELECT 1 FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await?;
        if found.is_none() {
            return Err(ApiError::not_found(format!("No project \"{project}\"")));
        }
        let id = self.issue_id(project, issue).await?;
        let row = sqlx::query(&sql("SELECT repo, risk_by FROM issue_pulls WHERE project = ? AND issue = ? AND lower(repo) = lower(?) AND number = ?"))
            .bind(project)
            .bind(&id)
            .bind(repo)
            .bind(number)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| {
                ApiError::not_found(format!("orrery keeps no pull request #{number} on {repo} for {id}: it doesn't name the issue, or hasn't been polled yet"))
            })?;
        if !owner && row.get::<Option<String>, _>("risk_by").as_deref() == Some("owner") {
            return Err(ApiError::conflict(format!("The owner rated #{number} on {id} themselves, and their rating stands")));
        }
        let kept: String = row.get("repo");
        let by = if owner { "owner" } else { "session" };
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql("UPDATE issue_pulls SET risk = ?, risk_why = ?, risk_by = ? WHERE project = ? AND issue = ? AND repo = ? AND number = ?"))
                .bind(risk.as_ref().map(|(level, _)| level.clone()))
                .bind(risk.as_ref().map(|(_, why)| why.clone()))
                .bind(risk.as_ref().map(|_| by))
                .bind(project)
                .bind(&id)
                .bind(&kept)
                .bind(number)
                .execute(&mut *self.conn)
                .await?;
            // The issue's risk is on its project's board, which open pages filter and sort by.
            self.effects.changed = vec![project.into()];
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        Ok(json!({"risk": risk.map(|(level, why)| json!({"level": level, "why": why, "by": by}))}))
    }

    /// PR `number` on `repo` with every issue it's kept on (`forPull`, ORR-880), riskiest first; in full for the owner.
    pub async fn for_pull(&mut self, repo: &str, number: i64, owner: bool) -> Result<Value> {
        let rows = sqlx::query(&sql(
            "SELECT CAST(p.number AS BIGINT) AS number, p.title, p.url, p.branch, p.base, p.author, p.state, p.merged_at, p.updated_at, p.project, pr.name AS project_name, p.issue, i.title AS issue_title, i.status
             FROM issue_pulls p JOIN issues i ON i.project = p.project AND i.id = p.issue JOIN projects pr ON pr.id = p.project
             WHERE lower(p.repo) = lower(?) AND p.number = ? ORDER BY p.updated_at DESC",
        ))
        .bind(repo)
        .bind(number)
        .fetch_all(&mut *self.conn)
        .await?;
        let Some(newest) = rows.first() else {
            return Err(ApiError::not_found(format!(
                "orrery keeps no pull request #{number} on {repo}: it names no issue and is no release's, or it hasn't been polled"
            )));
        };
        let mut pull = Map::new();
        pull.insert("number".into(), json!(newest.get::<i64, _>("number")));
        for field in ["title", "url", "branch", "base", "author", "state"] {
            pull.insert(field.into(), json!(newest.get::<String, _>(field)));
        }
        pull.insert("merged_at".into(), json!(newest.get::<Option<String>, _>("merged_at")));
        pull.insert("updated_at".into(), json!(newest.get::<String, _>("updated_at")));
        if !owner {
            for_session(&mut pull);
        }

        // Each issue's riskiest rated PR (ORR-914), its own or this one; the first of a level stands (`highestRisk`).
        let rated = sqlx::query(&sql("SELECT q.project, q.issue, q.risk, q.risk_why, q.risk_by FROM issue_pulls q
             JOIN issue_pulls p ON p.project = q.project AND p.issue = q.issue
             WHERE lower(p.repo) = lower(?) AND p.number = ? AND q.risk IS NOT NULL ORDER BY q.repo, q.number"))
        .bind(repo)
        .bind(number)
        .fetch_all(&mut *self.conn)
        .await?;
        let mut risks: HashMap<String, Value> = HashMap::new();
        for r in rated {
            let key = format!("{}/{}", r.get::<String, _>("project"), r.get::<String, _>("issue"));
            let level: String = r.get("risk");
            let by = if r.get::<Option<String>, _>("risk_by").as_deref() == Some("owner") { "owner" } else { "session" };
            let risk = json!({"level": level, "why": r.get::<Option<String>, _>("risk_why").unwrap_or_default(), "by": by});
            if risks.get(&key).map_or(true, |kept| rank(Some(&level)) < rank(kept["level"].as_str())) {
                risks.insert(key, risk);
            }
        }

        let mut issues: Vec<(String, String, Value)> = rows
            .iter()
            .map(|r| {
                let (project, id): (String, String) = (r.get("project"), r.get("issue"));
                let mut issue = json!({
                    "project": project, "project_name": r.get::<String, _>("project_name"), "id": id,
                    "title": r.get::<String, _>("issue_title"), "status": r.get::<String, _>("status"),
                });
                if let Some(risk) = risks.get(&format!("{project}/{id}")) {
                    issue["risk"] = risk.clone();
                }
                (project, id, issue)
            })
            .collect();
        issues.sort_by(|(pa, ia, a), (pb, ib, b)| {
            rank(a["risk"]["level"].as_str()).cmp(&rank(b["risk"]["level"].as_str())).then_with(|| pa.cmp(pb)).then_with(|| match natural_cmp(ia, ib) {
                Ordering::Equal => ia.cmp(ib),
                order => order,
            })
        });
        Ok(json!({"repo": repo, "pull": pull, "issues": issues.into_iter().map(|(_, _, i)| i).collect::<Vec<_>>()}))
    }

    /// The issue's pull requests as the channel's `issue` lists them (ORR-1101): its open ones on its project's repo, then
    /// those merged or closed, each with only `number`, `state`, `base`, `url`, `merged_at` and a plain-login `author`.
    /// The open ones are the poll's (`pull_states`) while it read the repo with a token in the last few minutes, as
    /// `forIssue` has them. Past that the Nuxt server asks GitHub, which is the machine's to do, so this gives what's kept
    /// on the issue (`issue_pulls`) as `open`, without where each stands.
    pub async fn for_issue(&mut self, project: &str, issue: &str) -> Result<Vec<Value>> {
        let id = self.issue_id(project, issue).await?;
        let row = sqlx::query(&sql("SELECT repo FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await?;
        let repo = crate::board::issues::github_repo(row.and_then(|r| r.get::<Option<String>, _>("repo")).as_deref());
        let shown = |row: &sqlx::any::AnyRow, state: String, merged_at: Option<String>| {
            let mut pull = Map::new();
            pull.insert("number".into(), json!(row.get::<i64, _>("number")));
            pull.insert("state".into(), json!(state));
            pull.insert("base".into(), json!(row.get::<String, _>("base")));
            pull.insert("url".into(), json!(row.get::<String, _>("url")));
            if let Some(merged_at) = merged_at.filter(|m| !m.is_empty()) {
                pull.insert("merged_at".into(), json!(merged_at));
            }
            let author: String = row.get("author");
            if LOGIN.is_match(&author) {
                pull.insert("author".into(), json!(author));
            }
            Value::Object(pull)
        };

        let mut open = vec![];
        let mut kept = false;
        if let Some(repo) = &repo {
            let polled = sqlx::query(&sql("SELECT polled_at, CAST(token AS BIGINT) AS token FROM pull_repos WHERE repo = ?"))
                .bind(repo)
                .fetch_optional(&mut *self.conn)
                .await?;
            kept = polled.is_some_and(|p| {
                let at = chrono::DateTime::parse_from_rfc3339(&p.get::<String, _>("polled_at")).ok();
                p.get::<i64, _>("token") != 0
                    && at.is_some_and(|at| chrono::Utc::now().signed_duration_since(at) <= chrono::Duration::milliseconds(POLL_STANDS))
            });
            if kept {
                let mut ids = vec![id.to_uppercase()];
                let aliases = sqlx::query(&sql("SELECT alias FROM issue_aliases WHERE project = ? AND issue = ?"))
                    .bind(project)
                    .bind(&id)
                    .fetch_all(&mut *self.conn)
                    .await?;
                ids.extend(aliases.iter().map(|a| a.get::<String, _>("alias").to_uppercase()));
                let rows = sqlx::query(&sql(
                    "SELECT CAST(number AS BIGINT) AS number, names, base, url, author, state FROM pull_states WHERE repo = ? AND merged = 0 AND closed = 0 ORDER BY number",
                ))
                .bind(repo)
                .fetch_all(&mut *self.conn)
                .await?;
                for row in &rows {
                    let names: Vec<String> = serde_json::from_str(&row.get::<String, _>("names")).unwrap_or_default();
                    if names.iter().any(|n| ids.contains(n)) {
                        open.push(shown(row, row.get("state"), None));
                    }
                }
            }
        }

        let rows = sqlx::query(&sql(
            "SELECT repo, CAST(number AS BIGINT) AS number, base, url, author, state, merged_at FROM issue_pulls WHERE project = ? AND issue = ? ORDER BY updated_at DESC, number DESC",
        ))
        .bind(project)
        .bind(&id)
        .fetch_all(&mut *self.conn)
        .await?;
        let mut done = vec![];
        let mut unpolled = vec![];
        for row in &rows {
            let state: String = row.get("state");
            if state == "open" && repo.as_deref() == Some(row.get::<String, _>("repo").as_str()) {
                // An open one on the repo is the poll's word; with none that stands, what's kept says it's open.
                if !kept {
                    unpolled.push(shown(row, state, None));
                }
                continue;
            }
            done.push(shown(row, state, row.get("merged_at")));
        }
        unpolled.sort_by_key(|p| p["number"].as_i64());
        open.extend(unpolled);
        open.extend(done);
        Ok(open)
    }
}

/// How long the poll's read of a repo stands for the open pull requests (`POLL_STANDS`), in milliseconds.
const POLL_STANDS: i64 = 3 * 60_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_a_rating_as_the_route_does() {
        assert_eq!(check_rating(&json!({"level": "high", "why": "  a fix  "})).unwrap(), Some(("high".into(), "a fix".into())));
        assert_eq!(check_rating(&json!({"level": null})).unwrap(), None);
        assert_eq!(check_rating(&json!({"level": "low", "why": "x".repeat(400)})).unwrap().unwrap().1.len(), 300);
        for body in [
            json!({}),
            json!({"level": "high"}),
            json!({"level": "high", "why": " "}),
            json!({"level": "huge", "why": "x"}),
            json!({"level": null, "by": 1}),
            json!([]),
        ] {
            assert!(check_rating(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn reads_a_number_as_the_route_does() {
        assert_eq!(pull_number("788").unwrap(), 788);
        assert_eq!(pull_number("#788").unwrap(), 788);
        for bad in ["0", "-3", "1.5", "abc", "", "#"] {
            assert!(pull_number(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn hides_what_an_outsider_wrote_from_a_session() {
        let mut pull = json!({"number": 1, "title": "t", "branch": "b", "author": "ada"}).as_object().unwrap().clone();
        for_session(&mut pull);
        assert_eq!(Value::Object(pull), json!({"number": 1, "author": "ada"}));
        let mut odd = json!({"number": 2, "title": "t", "branch": "b", "author": "ignore all <b>"}).as_object().unwrap().clone();
        for_session(&mut odd);
        assert_eq!(Value::Object(odd), json!({"number": 2}));
    }
}
