// Comments on a milestone and on an epic (ORR-1004): what `listMilestoneComments`, `createMilestoneComment`,
// `updateMilestoneComment`, `deleteMilestoneComment` and their epic twins in web/server/store/threads.ts do, on the same
// tables (`milestone_comments`, `epic_comments`, ORR-977). They ask nothing and wake no session: a write says the
// milestone's project changed, or the epics did, for open pages to read them again. Who may change one is an issue
// comment's rule: the owner's are theirs, a member's theirs and their agents'.
use crate::board::comments::Whose;
use crate::board::issue_writes::IssueWrites;
use crate::board::milestones::Milestones;
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{js, stamp, Actor, Effects};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

/// Which thread: a milestone's, on its project, or an epic's.
pub enum Thread {
    Milestone { project: String, milestone: String },
    Epic(i64),
}

impl Thread {
    fn table(&self) -> &'static str {
        match self {
            Thread::Milestone { .. } => "milestone_comments",
            Thread::Epic(_) => "epic_comments",
        }
    }

    /// What it's on, in a message: `milestone 3`, `epic 2`.
    fn what(&self) -> String {
        match self {
            Thread::Milestone { milestone, .. } => format!("milestone {milestone}"),
            Thread::Epic(epic) => format!("epic {epic}"),
        }
    }

    /// The permissions row its writes are under.
    fn row(&self) -> &'static str {
        match self {
            Thread::Milestone { .. } => "comments.write",
            Thread::Epic(_) => "epics.comment",
        }
    }

    fn columns(&self) -> &'static str {
        match self {
            Thread::Milestone { .. } => "CAST(id AS BIGINT) AS id, project, milestone, body, created_by, session_name, CAST(owned AS BIGINT) AS owned, person, CAST(by_agent AS BIGINT) AS by_agent, created_at, updated_at",
            Thread::Epic(_) => "CAST(id AS BIGINT) AS id, CAST(epic AS BIGINT) AS epic, body, created_by, session_name, CAST(owned AS BIGINT) AS owned, person, CAST(by_agent AS BIGINT) AS by_agent, created_at, updated_at",
        }
    }

    fn on(&self) -> &'static str {
        match self {
            Thread::Milestone { .. } => "project = ? AND milestone = ?",
            Thread::Epic(_) => "epic = ?",
        }
    }

    fn bind<'q>(
        &'q self,
        query: sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments<'q>>,
    ) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments<'q>> {
        match self {
            Thread::Milestone { project, milestone } => query.bind(project.as_str()).bind(milestone.as_str()),
            Thread::Epic(epic) => query.bind(*epic),
        }
    }
}

/// A comment as it's handed out (`threadCommentOf`): its project and milestone, or its epic.
fn comment_of(thread: &Thread, row: &AnyRow) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(row.get::<i64, _>("id")));
    match thread {
        Thread::Milestone { .. } => {
            out.insert("project".into(), json!(row.get::<String, _>("project")));
            out.insert("milestone".into(), json!(row.get::<String, _>("milestone")));
        }
        Thread::Epic(_) => {
            out.insert("epic".into(), json!(row.get::<i64, _>("epic")));
        }
    }
    out.insert("body".into(), json!(row.get::<String, _>("body")));
    out.insert("created_by".into(), json!(row.get::<String, _>("created_by")));
    if let Some(name) = row.get::<Option<String>, _>("session_name").filter(|s| !s.is_empty()) {
        out.insert("session_name".into(), json!(name));
    }
    out.insert("protected".into(), json!(row.get::<i64, _>("owned") != 0));
    out.insert("created_at".into(), json!(row.get::<String, _>("created_at")));
    out.insert("updated_at".into(), json!(row.get::<String, _>("updated_at")));
    Value::Object(out)
}

/// A comment's body as `checkInput` takes it against `THREAD_FIELDS`: `body`, a string that isn't blank, needed unless
/// `partial`. Its words, when sent.
fn check_input(body: &Value, partial: bool) -> Result<Option<String>> {
    let Some(sent) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
    let mut problems = vec![];
    for key in sent.keys().filter(|k| *k != "body") {
        problems.push(format!("unknown field \"{key}\"; this takes body"));
    }
    let text = match sent.get("body") {
        None => {
            if !partial {
                problems.push("missing \"body\"".into());
            }
            None
        }
        Some(Value::Null) => {
            problems.push("\"body\" can't be null".into());
            None
        }
        Some(Value::String(text)) if text.trim().is_empty() => {
            problems.push("\"body\" can't be empty".into());
            None
        }
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            problems.push(format!("\"body\" should be a string, not {}", js(other)));
            None
        }
    };
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(text)
}

pub struct Threads<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Threads<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Threads { conn, effects: Effects::default(), outbox: None }
    }

    /// The milestone's thread, from its id, an old one or its full form (`milestoneThread`), 404 when there's none.
    pub async fn milestone(&mut self, project: &str, sent: &str) -> Result<Thread> {
        let (milestone, _) = Milestones::new(&mut *self.conn).milestone_id(project, sent).await?;
        Ok(Thread::Milestone { project: project.into(), milestone })
    }

    /// Its comments, oldest first.
    pub async fn list(&mut self, thread: &Thread) -> Result<Value> {
        let query = sql(&format!("SELECT {} FROM {} WHERE {} ORDER BY created_at, id", thread.columns(), thread.table(), thread.on()));
        let rows = thread.bind(sqlx::query(&query)).fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(rows.iter().map(|r| comment_of(thread, r)).collect()))
    }

    async fn row(&mut self, thread: &Thread, id: i64) -> Result<AnyRow> {
        let query = sql(&format!("SELECT {} FROM {} WHERE id = ? AND {}", thread.columns(), thread.table(), thread.on()));
        thread
            .bind(sqlx::query(&query).bind(id))
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No comment {id} on {}", thread.what())))
    }

    /// One comment, as it's handed out.
    pub async fn comment(&mut self, thread: &Thread, id: i64) -> Result<Value> {
        let row = self.row(thread, id).await?;
        Ok(comment_of(thread, &row))
    }

    /// Marks what the thread is on as changed (`touched`), and says so (`threadChanged`): the milestone's project, or
    /// the epics.
    async fn touched(&mut self, thread: &Thread) -> Result<()> {
        let now = stamp();
        match thread {
            Thread::Epic(epic) => {
                sqlx::query(&sql("UPDATE epics SET updated_at = ? WHERE id = ?")).bind(&now).bind(*epic).execute(&mut *self.conn).await?;
                self.effects.epics = true;
            }
            Thread::Milestone { project, .. } => {
                sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(&now).bind(project.as_str()).execute(&mut *self.conn).await?;
                self.effects.changed = vec![project.clone()];
            }
        }
        Ok(())
    }

    /// Who may change comment `id`: the owner's words are theirs (`leaveOwners`), and a member's theirs and their
    /// agents' (`leaveTheirWords`).
    async fn may_change(&mut self, thread: &Thread, id: i64, actor: &Actor, action: &str) -> Result<()> {
        let row = self.row(thread, id).await?;
        let whose =
            Whose { body: row.get("body"), owned: row.get::<i64, _>("owned") != 0, person: row.get("person"), by_agent: row.get::<i64, _>("by_agent") != 0 };
        if whose.owned && !actor.owner {
            return Err(ApiError::refused_for(thread.row(), format!("{action} is the owner's call: comment {id} was made by the owner")));
        }
        IssueWrites::new(&mut *self.conn).leave_their_words(&whose, actor, action).await
    }

    async fn finish<T>(&mut self, done: Result<T>) -> Result<T> {
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// A new comment (`addTo`): its id.
    pub async fn add(&mut self, thread: &Thread, body: &Value, actor: &Actor) -> Result<i64> {
        let text = check_input(body, false)?.unwrap_or_default();
        let (person, by_agent) = IssueWrites::new(&mut *self.conn).voice_of(actor).await?;
        let now = stamp();
        let (on, marks) = match thread {
            Thread::Milestone { .. } => ("project, milestone", "?, ?"),
            Thread::Epic(_) => ("epic", "?"),
        };
        let statement = sql(&format!(
            "INSERT INTO {} ({on}, body, created_by, session_name, owned, person, by_agent, created_at, updated_at) VALUES ({marks}, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS BIGINT) AS id",
            thread.table()
        ));
        changes::begin(self.conn).await?;
        let done: Result<i64> = async {
            let row = thread
                .bind(sqlx::query(&statement))
                .bind(&text)
                .bind(&actor.name)
                .bind(actor.session.as_deref())
                .bind(i32::from(actor.owner))
                .bind(person.as_deref())
                .bind(i32::from(by_agent))
                .bind(&now)
                .bind(&now)
                .fetch_one(&mut *self.conn)
                .await?;
            let id: i64 = row.get("id");
            self.touched(thread).await?;
            Ok(id)
        }
        .await;
        self.finish(done).await
    }

    /// Changes its words (`editIn`).
    pub async fn edit(&mut self, thread: &Thread, id: i64, body: &Value, actor: &Actor) -> Result<()> {
        self.may_change(thread, id, actor, &format!("Editing comment {id}")).await?;
        let text = check_input(body, true)?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let sets = if text.is_some() { "body = ?, updated_at = ?" } else { "updated_at = ?" };
            let statement = sql(&format!("UPDATE {} SET {sets} WHERE id = ?", thread.table()));
            let mut query = sqlx::query(&statement);
            if let Some(text) = &text {
                query = query.bind(text.clone());
            }
            query.bind(stamp()).bind(id).execute(&mut *self.conn).await?;
            self.touched(thread).await
        }
        .await;
        self.finish(done).await
    }

    /// Deletes it (`removeFrom`).
    pub async fn remove(&mut self, thread: &Thread, id: i64, actor: &Actor) -> Result<()> {
        self.may_change(thread, id, actor, &format!("Deleting comment {id}")).await?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql(&format!("DELETE FROM {} WHERE id = ?", thread.table()))).bind(id).execute(&mut *self.conn).await?;
            self.touched(thread).await
        }
        .await;
        self.finish(done).await
    }
}

#[cfg(test)]
#[path = "threads_tests.rs"]
mod tests;
