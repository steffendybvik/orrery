// One pull request as orrery keeps it (ORR-952): what `forPull` in web/server/utils/pulls.ts does, on the same
// `issue_pulls` rows, answering as `GET /api/pulls/{owner}/{name}/{number}` does. The other pull reads (`GET /api/pulls`,
// `/api/pulls/branches`) ask GitHub when what's kept is stale, which is the local app's to do. Rating a PR's risk is
// written here too (ORR-952), with its outbox row (ORR-929); the poll keeping a PR stays the Nuxt server's, as a merge
// sets an issue's release and posts orrery's comments, and those writes are still Nuxt's.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::docs::{js, Effects};
use crate::error::{ApiError, Result};
use crate::text::natural_cmp;
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
}

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
