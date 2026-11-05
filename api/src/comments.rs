// An issue's comments and activity, reading them (ORR-927): what `listComments`, `comment` and `listActivity` in
// web/server/store/comments.ts do, on the same tables, answering as `GET …/issues/{issue}/comments`, `…/comments/{comment}`
// and `…/activity` do. Writing them stays the
// Nuxt server's for now, as a comment wakes sessions (ORR-929); the router sends only these reads here.
use crate::db::sql;
use crate::error::{ApiError, Result};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::collections::HashMap;

/// What a person's own words on comment `o` are: the owner's, or a member's (`PERSONS_WORDS`, ORR-658).
const SINCE: &str = "EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND (o.owned = 1 OR (o.person IS NOT NULL AND o.by_agent = 0)) AND o.id > c.id)";

fn columns() -> String {
    format!(
        "CAST(c.id AS BIGINT) AS id, c.issue, c.body, c.asks, c.created_by, c.session_name, CAST(c.owned AS BIGINT) AS owned, c.created_at, c.updated_at, \
         CAST(CASE WHEN {SINCE} THEN 1 ELSE 0 END AS BIGINT) AS answered"
    )
}

/// A comment as the store gives it (`commentOf`): `answered` only with `asks`, `session_name` only with one.
fn comment_of(row: &AnyRow) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(row.get::<i64, _>("id")));
    out.insert("issue".into(), json!(row.get::<String, _>("issue")));
    out.insert("body".into(), json!(row.get::<String, _>("body")));
    if let Some(asks) = row.get::<Option<String>, _>("asks") {
        out.insert("asks".into(), json!(asks));
        out.insert("answered".into(), json!(row.get::<i64, _>("answered") != 0));
    }
    out.insert("created_by".into(), json!(row.get::<String, _>("created_by")));
    if let Some(name) = row.get::<Option<String>, _>("session_name").filter(|s| !s.is_empty()) {
        out.insert("session_name".into(), json!(name));
    }
    out.insert("protected".into(), json!(row.get::<i64, _>("owned") != 0));
    out.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
    out.insert("updated_at".into(), json!(row.get::<String, _>("updated_at")));
    out
}

/// A change to an issue as the store gives it (`eventOf`): `before`, `after` and `session_name` only when there.
fn event_of(row: &AnyRow) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(row.get::<i64, _>("id")));
    out.insert("issue".into(), json!(row.get::<String, _>("issue")));
    out.insert("field".into(), json!(row.get::<String, _>("field")));
    for column in ["before", "after"] {
        if let Some(value) = row.get::<Option<String>, _>(column) {
            out.insert(column.into(), json!(value));
        }
    }
    out.insert("created_by".into(), json!(row.get::<String, _>("created_by")));
    if let Some(name) = row.get::<Option<String>, _>("session_name").filter(|s| !s.is_empty()) {
        out.insert("session_name".into(), json!(name));
    }
    out.insert("protected".into(), json!(row.get::<i64, _>("owned") != 0));
    out.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
    Value::Object(out)
}

/// A comment's id from the URL, as `commentId` reads it (`Number`, then whole): anything else is no comment.
pub fn comment_id(sent: &str) -> Result<i64> {
    let trimmed = sent.trim();
    match trimmed.parse::<f64>() {
        Ok(n) if !trimmed.is_empty() && n.is_finite() && n.fract() == 0.0 && n.abs() < 9e15 => Ok(n as i64),
        _ => Err(ApiError::not_found(format!("No comment {sent}"))),
    }
}

/// The issue id inside a full one with this `uid` (`shortId('issue', …)`): `ORR-12-x7k2m3qd` → `ORR-12`.
fn short_issue_id(id: &str, uid: &str) -> Option<String> {
    let tail = format!("-{uid}");
    (!uid.is_empty() && id.len() > tail.len() && id.ends_with(&tail)).then(|| id[..id.len() - tail.len()].to_string())
}

pub struct Comments<'c> {
    pub conn: &'c mut AnyConnection,
}

impl<'c> Comments<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Comments { conn }
    }

    async fn exists(&mut self, query: &str, project: &str, key: &str) -> Result<bool> {
        Ok(sqlx::query(&sql(query)).bind(project).bind(key).fetch_optional(&mut *self.conn).await?.is_some())
    }

    async fn project_uid(&mut self, project: &str) -> Result<String> {
        let row = sqlx::query(&sql("SELECT uid FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await?;
        row.map(|r| r.get::<Option<String>, _>("uid").unwrap_or_default()).ok_or_else(|| ApiError::not_found(format!("No project \"{project}\"")))
    }

    /// The issue's id, from its id, an id it had before (an alias), or the full form of either on this board (`issueId`).
    async fn issue_id(&mut self, project: &str, sent: &str) -> Result<String> {
        let mut id = sent.to_string();
        loop {
            if self.exists("SELECT 1 FROM issues WHERE project = ? AND id = ?", project, &id).await? {
                return Ok(id);
            }
            let alias = sqlx::query(&sql("SELECT issue FROM issue_aliases WHERE project = ? AND alias = ?"))
                .bind(project)
                .bind(&id)
                .fetch_optional(&mut *self.conn)
                .await?;
            if let Some(alias) = alias {
                return Ok(alias.get("issue"));
            }
            match short_issue_id(&id, &self.project_uid(project).await?) {
                Some(short) => id = short,
                None => return Ok(id),
            }
        }
    }

    /// Refuses a project or issue there isn't (`issueRow`).
    async fn issue_there(&mut self, project: &str, issue: &str) -> Result<()> {
        self.project_uid(project).await?;
        if !self.exists("SELECT 1 FROM issues WHERE project = ? AND id = ?", project, issue).await? {
            return Err(ApiError::not_found(format!("No issue {issue} in {project}")));
        }
        Ok(())
    }

    /// Each comment that asks for a schedule with its request (ORR-458), as `withScheduleRequests` adds it.
    async fn with_schedule_requests(&mut self, mut comments: Vec<Map<String, Value>>) -> Result<Vec<Value>> {
        if !comments.is_empty() {
            let marks = vec!["?"; comments.len()].join(", ");
            let query = format!("SELECT CAST(comment AS BIGINT) AS comment, CAST(schedule AS BIGINT) AS schedule, title, changes, body, state FROM schedule_requests WHERE comment IN ({marks})");
            let query = sql(&query);
            let mut asked = sqlx::query(&query);
            for comment in &comments {
                asked = asked.bind(comment["id"].as_i64().unwrap_or_default());
            }
            let mut requests: HashMap<i64, Value> = HashMap::new();
            for row in asked.fetch_all(&mut *self.conn).await? {
                let parse = |column: &str| serde_json::from_str::<Value>(&row.get::<String, _>(column)).unwrap_or(Value::Null);
                let mut request = Map::new();
                if let Some(schedule) = row.get::<Option<i64>, _>("schedule") {
                    request.insert("id".into(), json!(schedule));
                }
                request.insert("title".into(), json!(row.get::<String, _>("title")));
                request.insert("changes".into(), parse("changes"));
                request.insert("body".into(), parse("body"));
                request.insert("state".into(), json!(row.get::<String, _>("state")));
                requests.insert(row.get("comment"), Value::Object(request));
            }
            for comment in &mut comments {
                if let Some(request) = comment["id"].as_i64().and_then(|id| requests.remove(&id)) {
                    comment.insert("schedule".into(), request);
                }
            }
        }
        Ok(comments.into_iter().map(Value::Object).collect())
    }

    /// The issue's comments, oldest first.
    pub async fn list(&mut self, project: &str, sent: &str) -> Result<Value> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let query = format!("SELECT {} FROM comments c WHERE c.project = ? AND c.issue = ? ORDER BY c.created_at, c.id", columns());
        let rows = sqlx::query(&sql(&query)).bind(project).bind(&issue).fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(self.with_schedule_requests(rows.iter().map(comment_of).collect()).await?))
    }

    /// Who changed what on the issue, and when, oldest first.
    pub async fn activity(&mut self, project: &str, sent: &str) -> Result<Value> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let query =
            "SELECT CAST(id AS BIGINT) AS id, issue, field, \"before\", \"after\", created_by, session_name, CAST(owned AS BIGINT) AS owned, created_at \
                     FROM issue_events WHERE project = ? AND issue = ? ORDER BY created_at, id";
        let rows = sqlx::query(&sql(query)).bind(project).bind(&issue).fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(rows.iter().map(event_of).collect()))
    }

    /// One comment on the issue.
    pub async fn comment(&mut self, project: &str, sent: &str, id: i64) -> Result<Value> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let query = format!("SELECT {} FROM comments c WHERE c.project = ? AND c.issue = ? AND c.id = ?", columns());
        let row = sqlx::query(&sql(&query)).bind(project).bind(&issue).bind(id).fetch_optional(&mut *self.conn).await?;
        let row = row.ok_or_else(|| ApiError::not_found(format!("No comment {id} on {issue}")))?;
        Ok(self.with_schedule_requests(vec![comment_of(&row)]).await?.remove(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(short_issue_id("ORR-12-x7k2m3qd", "x7k2m3qd").as_deref(), Some("ORR-12"));
        assert_eq!(short_issue_id("ORR-12-x7k2m3qd", "aaaaaaaa"), None);
        assert_eq!(comment_id("12").unwrap(), 12);
        assert_eq!(comment_id(" 12.0 ").unwrap(), 12);
        assert!(comment_id("abc").is_err() && comment_id("1.5").is_err() && comment_id("").is_err());
    }
}
