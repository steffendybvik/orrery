// Which session is on which issue, read for the Nuxt server (ORR-1141), so its session bookkeeping (clearing, picking,
// the Todo hand-out, the signal feed) reads the board over HTTP rather than from the database (ORR-1093). The same
// rows and answers as `workingOn`, `waiting`/`waitingFor`, `takenFrom`/`heldAbove` and `dependentsOf` in
// web/server/store. Whether a session is there to hear stays the Nuxt server's, as it's this machine's: the workers
// come back as they're stored, and it drops those not listening.
use crate::board::comments::{columns, comment_of};
use crate::board::issues::Issues;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::stamp;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::collections::{HashMap, HashSet};

/// What a signal for every session names as its target (`EVERY` in web/server/store/signals.ts).
const EVERY: &str = "*";

pub(crate) struct SessionWork<'c> {
    conn: &'c mut AnyConnection,
}

/// `?, ?, ?` for `n` binds.
fn marks(n: usize) -> String {
    vec!["?"; n].join(", ")
}

impl<'c> SessionWork<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        SessionWork { conn }
    }

    /// The issues in progress (a started status) one of `sessions` worked last, each with its latest comment as `last`,
    /// as `workingOn` gives them: none on a project there isn't.
    pub(crate) async fn working_on(&mut self, project: &str, sessions: &[String]) -> Result<Vec<Value>> {
        if sessions.is_empty() {
            return Ok(vec![]);
        }
        let text = sql(&format!("SELECT issue FROM issue_sessions WHERE project = ? AND session IN ({})", marks(sessions.len())));
        let mut query = sqlx::query(&text).bind(project);
        for session in sessions {
            query = query.bind(session);
        }
        let worked: HashSet<String> = query.fetch_all(&mut *self.conn).await?.iter().map(|r| r.get::<String, _>("issue")).collect();
        if worked.is_empty() {
            return Ok(vec![]);
        }
        let listed = Issues::new(self.conn).list(project, &HashMap::new()).await?;
        let mut issues: Vec<Map<String, Value>> = listed
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .filter(|i| i.get("id").and_then(Value::as_str).is_some_and(|id| worked.contains(id)) && i.get("kind").and_then(Value::as_str) == Some("started"))
            .cloned()
            .collect();
        if issues.is_empty() {
            return Ok(vec![]);
        }
        // Their comments in one query, not one each, the latest of each kept.
        let ids: Vec<String> = issues.iter().map(|i| i["id"].as_str().unwrap_or_default().to_string()).collect();
        let text = sql(&format!("SELECT {} FROM comments c WHERE c.project = ? AND c.issue IN ({}) ORDER BY c.created_at, c.id", columns(), marks(ids.len())));
        let mut query = sqlx::query(&text).bind(project);
        for id in &ids {
            query = query.bind(id);
        }
        let mut last: HashMap<String, Map<String, Value>> = HashMap::new();
        for row in query.fetch_all(&mut *self.conn).await? {
            last.insert(row.get::<String, _>("issue"), comment_of(&row));
        }
        for issue in &mut issues {
            let id = issue["id"].as_str().unwrap_or_default().to_string();
            if let Some(comment) = last.remove(&id) {
                issue.insert("last".into(), Value::Object(comment));
            }
        }
        Ok(issues.into_iter().map(Value::Object).collect())
    }

    /// Whether a signal of the owner's waits to reach one of `ids`: `any`, sent to it, every session or the one orrery
    /// picks (`waiting`); `own`, sent to it by name (`waitingFor`).
    pub(crate) async fn waiting(&mut self, project: &str, ids: &[String]) -> Result<(bool, bool)> {
        let unheard = "SELECT 1 FROM signals WHERE project = ? AND owned = 1 AND delivered_to = '[]'";
        if ids.is_empty() {
            return Ok((self.any_waiting(project, unheard).await?, false));
        }
        let text = sql(&format!("{unheard} AND target IN ({}) LIMIT 1", marks(ids.len())));
        let mut own = sqlx::query(&text).bind(project);
        for id in ids {
            own = own.bind(id);
        }
        let own = own.fetch_optional(&mut *self.conn).await?.is_some();
        if own {
            return Ok((true, true));
        }
        Ok((self.any_waiting(project, unheard).await?, false))
    }

    /// Whether one of the owner's signals waits for every session or the one orrery picks.
    async fn any_waiting(&mut self, project: &str, unheard: &str) -> Result<bool> {
        Ok(sqlx::query(&sql(&format!("{unheard} AND (target IS NULL OR target = ?) LIMIT 1")))
            .bind(project)
            .bind(EVERY)
            .fetch_optional(&mut *self.conn)
            .await?
            .is_some())
    }

    /// The issue and each above it, nearest first: `{issue, started, worker}`, `worker` the session that last worked it
    /// (null when none has). `takenFrom` reads the first, `heldAbove` the rest. A 404 for an issue there isn't.
    pub(crate) async fn workers(&mut self, project: &str, issue: &str) -> Result<Vec<Value>> {
        let mut issues = Issues::new(self.conn);
        issues.project(project).await?;
        let started: HashSet<String> = issues.statuses().await?.into_iter().filter(|s| s.kind == "started").map(|s| s.id).collect();
        let mut at = Some(issues.resolve(project, issue, false).await?);
        let mut chain = vec![];
        // A loop in the parents would never end: each issue is walked once.
        let mut seen = HashSet::new();
        while let Some(id) = at.take().filter(|id| seen.insert(id.clone())) {
            let Some(row): Option<AnyRow> = sqlx::query(&sql("SELECT status, parent FROM issues WHERE project = ? AND id = ?"))
                .bind(project)
                .bind(&id)
                .fetch_optional(&mut *self.conn)
                .await?
            else {
                break;
            };
            let worker: Option<String> = sqlx::query(&sql("SELECT session FROM issue_sessions WHERE project = ? AND issue = ?"))
                .bind(project)
                .bind(&id)
                .fetch_optional(&mut *self.conn)
                .await?
                .map(|r| r.get("session"));
            let status: String = row.get("status");
            chain.push(json!({"issue": id, "started": started.contains(&status), "worker": worker}));
            at = row.get::<Option<String>, _>("parent");
        }
        if chain.is_empty() {
            return Err(ApiError::not_found(format!("No issue {issue} in {project}")));
        }
        Ok(chain)
    }

    /// The issues that depend on this one, in any project, oldest link first, as `dependentsOf` gives them.
    pub(crate) async fn dependents(&mut self, project: &str, issue: &str) -> Result<Vec<Value>> {
        let mut issues = Issues::new(self.conn);
        issues.project(project).await?;
        let issue = issues.resolve(project, issue, false).await?;
        let rows = sqlx::query(&sql("SELECT project, issue FROM issue_links WHERE on_project = ? AND on_issue = ? ORDER BY created_at, project, issue"))
            .bind(project)
            .bind(&issue)
            .fetch_all(&mut *self.conn)
            .await?;
        Ok(rows.iter().map(|r| json!({"project": r.get::<String, _>("project"), "id": r.get::<String, _>("issue")})).collect())
    }

    /// Notes that `session` is working the issue, as `workedBy` does once it's checked no other session has it started
    /// and there to hear: `since` is kept while the same session works it again. An issue there isn't is let be.
    pub(crate) async fn worked_by(&mut self, project: &str, issue: &str, session: &str) -> Result<()> {
        let mut issues = Issues::new(self.conn);
        issues.project(project).await?;
        let issue = issues.resolve(project, issue, false).await?;
        let now = stamp();
        sqlx::query(&sql(
            "INSERT INTO issue_sessions (project, issue, session, at, since) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE project = ? AND id = ?) \
             ON CONFLICT (project, issue) DO UPDATE SET since = CASE WHEN issue_sessions.session = excluded.session THEN issue_sessions.since ELSE excluded.since END, \
             session = excluded.session, at = excluded.at",
        ))
        .bind(project)
        .bind(&issue)
        .bind(session)
        .bind(&now)
        .bind(&now)
        .bind(project)
        .bind(&issue)
        .execute(&mut *self.conn)
        .await?;
        Ok(())
    }
}
