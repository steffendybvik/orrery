// Which session is on which issue, read for the Nuxt server (ORR-1141), so its session bookkeeping (clearing, picking,
// the Todo hand-out, the signal feed) reads the board over HTTP rather than from the database (ORR-1093). The same
// rows and answers as `workingOn`, `waiting`/`waitingFor`, `takenFrom`/`heldAbove` and `dependentsOf` in
// web/server/store. Whether a session is there to hear stays the Nuxt server's, as it's this machine's: the workers
// come back as they're stored, and it drops those not listening.
use crate::board::comments::{columns, comment_of, ORRERY};
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

/// A session `work` is asked about: its id, the name signals for every session are heard by, and all its ids (its old
/// ones after a `/clear` too; its id alone when none are given).
#[derive(serde::Deserialize)]
pub(crate) struct Asked {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) ids: Vec<String>,
}

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

    /// What each of `sessions` is on, as `sessionWork` gives it for the Sessions page (ORR-1174): `issues`, the open ones
    /// (not proposed, not closed) it worked, the newest first, each with its id, title, column, kind and priority (and
    /// `since`, when it started it); `signals`, the latest `count` of the project's last 200 that went to it, by one of
    /// its ids or, for every session, heard by its name. A 404 for a project there isn't.
    pub(crate) async fn work(&mut self, project: &str, sessions: &[Asked], count: usize) -> Result<Value> {
        crate::board::issue_writes::IssueWrites::new(&mut *self.conn).project_uid(project).await?;
        let listed = Issues::new(self.conn).list(project, &HashMap::new()).await?;
        let open: HashMap<&str, &Map<String, Value>> = listed
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .filter(|i| !matches!(i.get("kind").and_then(Value::as_str), Some("proposed" | "done" | "canceled")))
            .filter_map(|i| Some((i.get("id")?.as_str()?, i)))
            .collect();
        let worked = sqlx::query(&sql("SELECT issue, session, since FROM issue_sessions WHERE project = ? ORDER BY at DESC"))
            .bind(project)
            .fetch_all(&mut *self.conn)
            .await?;
        let recent = crate::work::signals::Signals::new(&mut *self.conn).recent(project, 200).await?;
        let mut out = Map::new();
        for session in sessions {
            let ids: Vec<&str> = if session.ids.is_empty() { vec![session.id.as_str()] } else { session.ids.iter().map(String::as_str).collect() };
            let issues: Vec<Value> = worked
                .iter()
                .filter(|w| ids.contains(&w.get::<String, _>("session").as_str()))
                .filter_map(|w| {
                    let found = open.get(w.get::<String, _>("issue").as_str())?;
                    let mut issue = Map::new();
                    for field in ["id", "title", "column", "kind", "priority"] {
                        if let Some(value) = found.get(field) {
                            issue.insert(field.into(), value.clone());
                        }
                    }
                    if let Some(since) = w.get::<Option<String>, _>("since").filter(|s| !s.is_empty()) {
                        issue.insert("since".into(), Value::from(since));
                    }
                    Some(Value::Object(issue))
                })
                .collect();
            let signals: Vec<Value> = recent
                .iter()
                .filter(|s| {
                    let target = s.get("target").and_then(Value::as_str);
                    let heard = s.get("delivered_to").and_then(Value::as_array).is_some_and(|to| to.iter().any(|n| n.as_str() == Some(session.name.as_str())));
                    ids.contains(&target.unwrap_or("")) || ((target.is_none() || target == Some(EVERY)) && heard)
                })
                .take(count)
                .cloned()
                .collect();
            out.insert(session.id.clone(), json!({"issues": issues, "signals": signals}));
        }
        Ok(Value::Object(out))
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

    /// The owner's comments in the project that no agent has answered and no session has had yet, nor waits in the
    /// pool for one to take, as `carryUnanswered` reads them (ORR-1161): `[{issue, body, created_by, owned, assignee}]`,
    /// oldest first, ten at most. A member's (`person`) own words count too, on what's theirs. Who each goes to stays
    /// the local app's, as it picks the session. orrery's own word after one answers nothing (ORR-528), and one older
    /// than the signals kept isn't carried (ORR-778).
    pub(crate) async fn unanswered(&mut self, project: &str, person: Option<&str>) -> Result<Vec<Value>> {
        let ago = |days: i64| (chrono::Utc::now() - chrono::Duration::days(days)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let rows = sqlx::query(&sql("SELECT c.issue, c.body, c.created_by, CAST(c.owned AS BIGINT) AS owned, \
                    (SELECT i.assignee FROM issues i WHERE i.project = c.project AND i.id = c.issue) AS assignee FROM comments c \
             WHERE c.project = ? AND c.created_at >= ? AND (c.owned = 1 OR (c.person = ? AND c.by_agent = 0 \
                 AND EXISTS (SELECT 1 FROM issues i WHERE i.project = c.project AND i.id = c.issue AND lower(i.assignee) = c.person))) \
               AND NOT EXISTS (SELECT 1 FROM comments a WHERE a.project = c.project AND a.issue = c.issue \
                               AND NOT (a.owned = 1 OR (a.person IS NOT NULL AND a.by_agent = 0)) AND a.created_by != ? AND a.id > c.id) \
               AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.project = c.project AND s.issue = c.issue AND s.kind = 'comment' \
                               AND s.created_at >= c.created_at AND (s.delivered_to != '[]' OR (s.target IS NULL AND s.created_at >= ?))) \
             ORDER BY c.created_at LIMIT 10"))
        .bind(project)
        .bind(ago(crate::work::signals::KEEP_DAYS))
        .bind(person)
        .bind(ORRERY)
        .bind(ago(1))
        .fetch_all(&mut *self.conn)
        .await?;
        Ok(rows
            .iter()
            .map(|r| {
                json!({
                    "issue": r.get::<String, _>("issue"),
                    "body": r.get::<String, _>("body"),
                    "created_by": r.get::<String, _>("created_by"),
                    "owned": r.get::<i64, _>("owned") == 1,
                    "assignee": r.get::<Option<String>, _>("assignee"),
                })
            })
            .collect())
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

    /// A session's new id (after a `/clear`) takes over the issues its old one worked, as `renameSession` does. How
    /// many moved.
    pub(crate) async fn rename(&mut self, project: &str, from: &str, to: &str) -> Result<u64> {
        Ok(sqlx::query(&sql("UPDATE issue_sessions SET session = ? WHERE project = ? AND session = ?"))
            .bind(to)
            .bind(project)
            .bind(from)
            .execute(&mut *self.conn)
            .await?
            .rows_affected())
    }
}
