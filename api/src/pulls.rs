// One pull request as orrery keeps it (ORR-952): what `forPull` in web/server/utils/pulls.ts does, on the same
// `issue_pulls` rows, answering as `GET /api/pulls/{owner}/{name}/{number}` does. The other pull reads (`GET /api/pulls`,
// `/api/pulls/branches`) ask GitHub when what's kept is stale, which is the local app's to do, and every write (the poll
// keeping a PR, a rating) wakes sessions or tells the event log (ORR-929), so they all stay the Nuxt server's. The
// router sends only this read here.
use crate::db::sql;
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

pub struct Pulls<'a> {
    conn: &'a mut AnyConnection,
}

impl<'a> Pulls<'a> {
    pub fn new(conn: &'a mut AnyConnection) -> Self {
        Self { conn }
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
