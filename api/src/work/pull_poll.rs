// The GitHub poll's writes (ORR-952): what `keepPolled`, `keepFailed`, `keepHistory` and `keepForgotten` in
// web/server/utils/pull-poll.ts do to `pull_states` and `pull_repos`. The poll stays the local app's, as it asks
// GitHub and tells what changed; once the API is swapped in, it hands each step here. Written ahead: the router sends
// none of them yet. They tell nobody, as the store's don't: a PR's news is the poll's to tell.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{js, Effects};
use serde_json::{json, Map, Value};
use sqlx::{AnyConnection, Row};

/// A PR as the poll keeps it (`PolledRow`): the columns of `pull_states` but `repo` and `seen_at`.
struct Polled {
    number: i64,
    names: String,
    title: String,
    url: String,
    branch: String,
    base: String,
    author: String,
    draft: bool,
    head_sha: Option<String>,
    state: String,
    review: Option<String>,
    review_id: Option<String>,
    checks: Option<String>,
    merged: bool,
    closed: bool,
    merge_sha: Option<String>,
    closed_by: Option<String>,
    created_at: String,
    updated_at: String,
    told: String,
}

/// Each problem with one field of a body, said as `checkInput` would.
struct Fields<'b> {
    sent: &'b Map<String, Value>,
    at: String,
    problems: Vec<String>,
}

impl<'b> Fields<'b> {
    fn new(sent: &'b Map<String, Value>, at: &str, takes: &[&str]) -> Self {
        let mut problems = vec![];
        for key in sent.keys() {
            if !takes.contains(&key.as_str()) {
                problems.push(format!("{at}unknown field \"{key}\"; this takes {}", takes.join(", ")));
            }
        }
        Fields { sent, at: at.into(), problems }
    }

    fn missing(&mut self, key: &str) {
        self.problems.push(format!("{}missing \"{key}\"", self.at));
    }

    fn wrong(&mut self, key: &str, what: &str, value: &Value) {
        self.problems.push(format!("{}\"{key}\" should be {what}, not {}", self.at, js(value)));
    }

    fn text(&mut self, key: &str) -> String {
        match self.sent.get(key) {
            Some(Value::String(t)) => t.clone(),
            Some(other) => {
                self.wrong(key, "a string", other);
                String::new()
            }
            None => {
                self.missing(key);
                String::new()
            }
        }
    }

    fn nullable(&mut self, key: &str) -> Option<String> {
        match self.sent.get(key) {
            Some(Value::String(t)) => Some(t.clone()),
            Some(Value::Null) => None,
            Some(other) => {
                self.wrong(key, "a string or null", other);
                None
            }
            None => {
                self.missing(key);
                None
            }
        }
    }

    fn flag(&mut self, key: &str) -> bool {
        match self.sent.get(key) {
            Some(Value::Bool(b)) => *b,
            Some(other) => {
                self.wrong(key, "true or false", other);
                false
            }
            None => {
                self.missing(key);
                false
            }
        }
    }

    fn whole(&mut self, key: &str) -> i64 {
        match self.sent.get(key) {
            Some(n) if n.as_i64().is_some_and(|n| n >= 0) => n.as_i64().unwrap_or_default(),
            Some(other) => {
                self.wrong(key, "a whole number", other);
                0
            }
            None => {
                self.missing(key);
                0
            }
        }
    }

    /// A list of strings, kept as JSON as the table keeps it.
    fn strings(&mut self, key: &str) -> Vec<String> {
        match self.sent.get(key) {
            Some(Value::Array(items)) if items.iter().all(Value::is_string) => items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect(),
            Some(other) => {
                self.wrong(key, "a list of strings", other);
                vec![]
            }
            None => {
                self.missing(key);
                vec![]
            }
        }
    }
}

fn object(body: &Value) -> Result<&Map<String, Value>> {
    body.as_object().ok_or_else(|| ApiError::bad_request("The body should be a JSON object"))
}

const PULL_FIELDS: [&str; 20] = [
    "number",
    "names",
    "title",
    "url",
    "branch",
    "base",
    "author",
    "draft",
    "head_sha",
    "state",
    "review",
    "review_id",
    "checks",
    "merged",
    "closed",
    "merge_sha",
    "closed_by",
    "created_at",
    "updated_at",
    "told",
];

/// `{at, token, more, pulls}`, each of `pulls` a `PolledRow`.
fn check_polled(body: &Value) -> Result<(String, bool, bool, Vec<Polled>)> {
    let sent = object(body)?;
    let mut fields = Fields::new(sent, "", &["at", "token", "more", "pulls"]);
    let at = fields.text("at");
    let (token, more) = (fields.flag("token"), fields.flag("more"));
    let mut problems = std::mem::take(&mut fields.problems);
    let mut pulls = vec![];
    match sent.get("pulls") {
        Some(Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                let Some(pull) = item.as_object() else {
                    problems.push(format!("pulls[{i}] should be an object, not {}", js(item)));
                    continue;
                };
                let mut f = Fields::new(pull, &format!("pulls[{i}]: "), &PULL_FIELDS);
                let polled = Polled {
                    number: f.whole("number"),
                    names: json!(f.strings("names")).to_string(),
                    title: f.text("title"),
                    url: f.text("url"),
                    branch: f.text("branch"),
                    base: f.text("base"),
                    author: f.text("author"),
                    draft: f.flag("draft"),
                    head_sha: f.nullable("head_sha"),
                    state: f.text("state"),
                    review: f.nullable("review"),
                    review_id: f.nullable("review_id"),
                    checks: f.nullable("checks"),
                    merged: f.flag("merged"),
                    closed: f.flag("closed"),
                    merge_sha: f.nullable("merge_sha"),
                    closed_by: f.nullable("closed_by"),
                    created_at: f.text("created_at"),
                    updated_at: f.text("updated_at"),
                    told: json!(f.strings("told")).to_string(),
                };
                problems.append(&mut f.problems);
                pulls.push(polled);
            }
        }
        Some(other) => problems.push(format!("\"pulls\" should be a list, not {}", js(other))),
        None => problems.push("missing \"pulls\"".into()),
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok((at, token, more, pulls))
}

pub struct PullPoll<'c> {
    conn: &'c mut AnyConnection,
    pub effects: Effects,
    pub outbox: Option<Outbox>,
}

impl<'c> PullPoll<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        PullPoll { conn, effects: Effects::default(), outbox: None }
    }

    async fn finish(&mut self, done: Result<()>) -> Result<()> {
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// A repo's poll (`keepPolled`): each PR as read, those open when last seen and in neither list now kept as closed
    /// (not when the open ones were cut short, `more`), and the repo as polled.
    pub async fn polled(&mut self, repo: &str, body: &Value) -> Result<()> {
        let (at, token, more, pulls) = check_polled(body)?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let before = sqlx::query(&sql("SELECT CAST(number AS BIGINT) AS number, CAST(merged AS BIGINT) AS merged, CAST(closed AS BIGINT) AS closed FROM pull_states WHERE repo = ?"))
                .bind(repo)
                .fetch_all(&mut *self.conn)
                .await?;
            for p in &pulls {
                sqlx::query(&sql(
                    "INSERT INTO pull_states (repo, number, names, title, url, branch, base, author, draft, head_sha, state, review, review_id, checks,
                    merged, closed, merge_sha, closed_by, created_at, updated_at, seen_at, told) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (repo, number) DO UPDATE SET names = excluded.names, title = excluded.title, url = excluded.url, branch = excluded.branch,
                    base = excluded.base, author = excluded.author, draft = excluded.draft, head_sha = excluded.head_sha, state = excluded.state,
                    review = excluded.review, review_id = excluded.review_id, checks = excluded.checks, merged = excluded.merged, closed = excluded.closed,
                    merge_sha = excluded.merge_sha, closed_by = excluded.closed_by, updated_at = excluded.updated_at, seen_at = excluded.seen_at, told = excluded.told",
                ))
                .bind(repo)
                .bind(p.number)
                .bind(&p.names)
                .bind(&p.title)
                .bind(&p.url)
                .bind(&p.branch)
                .bind(&p.base)
                .bind(&p.author)
                .bind(i32::from(p.draft))
                .bind(&p.head_sha)
                .bind(&p.state)
                .bind(&p.review)
                .bind(&p.review_id)
                .bind(&p.checks)
                .bind(i32::from(p.merged))
                .bind(i32::from(p.closed))
                .bind(&p.merge_sha)
                .bind(&p.closed_by)
                .bind(&p.created_at)
                .bind(&p.updated_at)
                .bind(&at)
                .bind(&p.told)
                .execute(&mut *self.conn)
                .await?;
            }
            // Closed or merged in a rush the lists missed: kept as closed, told nothing.
            for was in &before {
                let number: i64 = was.get("number");
                let done = was.get::<i64, _>("merged") != 0 || was.get::<i64, _>("closed") != 0;
                if more || done || pulls.iter().any(|p| p.number == number) {
                    continue;
                }
                sqlx::query(&sql("UPDATE pull_states SET closed = 1, seen_at = ? WHERE repo = ? AND number = ?"))
                    .bind(&at)
                    .bind(repo)
                    .bind(number)
                    .execute(&mut *self.conn)
                    .await?;
                sqlx::query(&sql("UPDATE issue_pulls SET state = 'closed', updated_at = ? WHERE repo = ? AND number = ? AND state = 'open'"))
                    .bind(&at)
                    .bind(repo)
                    .bind(number)
                    .execute(&mut *self.conn)
                    .await?;
            }
            sqlx::query(&sql(
                "INSERT INTO pull_repos (repo, polled_at, token, error) VALUES (?, ?, ?, NULL)
                ON CONFLICT (repo) DO UPDATE SET polled_at = excluded.polled_at, token = excluded.token, error = NULL",
            ))
            .bind(repo)
            .bind(&at)
            .bind(i32::from(token))
            .execute(&mut *self.conn)
            .await?;
            Ok(())
        }
        .await;
        self.finish(done).await
    }

    /// What a repo's poll failed on (`keepFailed`): said on a repo read before, and nothing on one never read.
    pub async fn failed(&mut self, repo: &str, body: &Value) -> Result<()> {
        let sent = object(body)?;
        let mut fields = Fields::new(sent, "", &["error"]);
        let error = fields.text("error");
        if !fields.problems.is_empty() {
            return Err(ApiError::problems(fields.problems));
        }
        changes::begin(self.conn).await?;
        let done = sqlx::query(&sql("UPDATE pull_repos SET error = ? WHERE repo = ?"))
            .bind(&error)
            .bind(repo)
            .execute(&mut *self.conn)
            .await
            .map(|_| ())
            .map_err(Into::into);
        self.finish(done).await
    }

    /// The page of a repo's closed PRs to read next, 0 once they're all on their issues (`keepHistory`).
    pub async fn history(&mut self, repo: &str, body: &Value) -> Result<()> {
        let sent = object(body)?;
        let mut fields = Fields::new(sent, "", &["page"]);
        let page = fields.whole("page");
        if !fields.problems.is_empty() {
            return Err(ApiError::problems(fields.problems));
        }
        changes::begin(self.conn).await?;
        let done = sqlx::query(&sql("UPDATE pull_repos SET history_page = ? WHERE repo = ?"))
            .bind(page)
            .bind(repo)
            .execute(&mut *self.conn)
            .await
            .map(|_| ())
            .map_err(Into::into);
        self.finish(done).await
    }

    /// Lets go of merged and closed PRs last seen before `before`, and of the repos not in `repos` (`keepForgotten`):
    /// `{gone}`, the repos let go of.
    pub async fn forget(&mut self, body: &Value) -> Result<Value> {
        let sent = object(body)?;
        let mut fields = Fields::new(sent, "", &["repos", "before"]);
        let repos = fields.strings("repos");
        let before = fields.text("before");
        if !fields.problems.is_empty() {
            return Err(ApiError::problems(fields.problems));
        }
        changes::begin(self.conn).await?;
        let mut gone: Vec<String> = vec![];
        let done: Result<()> = async {
            sqlx::query(&sql("DELETE FROM pull_states WHERE (merged = 1 OR closed = 1) AND seen_at < ?")).bind(&before).execute(&mut *self.conn).await?;
            let kept = sqlx::query("SELECT repo FROM pull_repos").fetch_all(&mut *self.conn).await?;
            gone = kept.iter().map(|r| r.get::<String, _>("repo")).filter(|r| !repos.contains(r)).collect();
            for repo in &gone {
                for statement in ["DELETE FROM pull_states WHERE repo = ?", "DELETE FROM pull_repos WHERE repo = ?"] {
                    sqlx::query(&sql(statement)).bind(repo).execute(&mut *self.conn).await?;
                }
            }
            Ok(())
        }
        .await;
        self.finish(done).await?;
        Ok(json!({"gone": gone}))
    }

    /// What the poll reads of a repo before it polls it (ORR-1153): `repo`, whether it was last read with a token and
    /// the page of its closed PRs to read next, null before its first poll; `pulls`, each PR kept, with what a poll
    /// tells its changes by; and `recorded`, when each PR kept on an issue last changed, so one that hasn't isn't
    /// written again.
    pub async fn kept(&mut self, repo: &str) -> Result<Value> {
        let row = sqlx::query(&sql("SELECT CAST(token AS BIGINT) AS token, CAST(history_page AS BIGINT) AS history_page FROM pull_repos WHERE repo = ?"))
            .bind(repo)
            .fetch_optional(&mut *self.conn)
            .await?;
        let polled = row.map(|r| json!({"token": r.get::<i64, _>("token") != 0, "history_page": r.get::<Option<i64>, _>("history_page").unwrap_or(0)}));
        let pulls = sqlx::query(&sql(
            "SELECT CAST(number AS BIGINT) AS number, state, review, review_id, checks, CAST(merged AS BIGINT) AS merged, CAST(closed AS BIGINT) AS closed, told \
             FROM pull_states WHERE repo = ? ORDER BY number",
        ))
        .bind(repo)
        .fetch_all(&mut *self.conn)
        .await?
        .iter()
        .map(|r| {
            let told: Value = serde_json::from_str(&r.get::<String, _>("told")).unwrap_or_else(|_| json!([]));
            json!({"number": r.get::<i64, _>("number"), "state": r.get::<String, _>("state"), "review": r.get::<Option<String>, _>("review"),
                "review_id": r.get::<Option<String>, _>("review_id"), "checks": r.get::<Option<String>, _>("checks"),
                "merged": r.get::<i64, _>("merged") != 0, "closed": r.get::<i64, _>("closed") != 0, "told": told})
        })
        .collect::<Vec<_>>();
        let recorded = sqlx::query(&sql("SELECT CAST(number AS BIGINT) AS number, updated_at FROM issue_pulls WHERE repo = ? ORDER BY number"))
            .bind(repo)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| json!({"number": r.get::<i64, _>("number"), "updated_at": r.get::<String, _>("updated_at")}))
            .collect::<Vec<_>>();
        Ok(json!({"repo": polled, "pulls": pulls, "recorded": recorded}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_each_problem_with_a_poll() {
        assert!(check_polled(&json!({"at": "2026-11-05T10:00:00Z", "token": true, "more": false, "pulls": []})).is_ok());
        assert!(check_polled(&json!({"at": 1, "token": true, "pulls": [{"number": -1, "colour": "red"}]})).is_err());
        assert!(check_polled(&json!([])).is_err());
    }
}
