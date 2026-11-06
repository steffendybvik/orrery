// An issue's comments and activity (ORR-927): what `listComments`, `comment`, `listActivity`, `createComment`,
// `updateComment` and `deleteComment` in web/server/store/comments.ts do, on the same tables, answering as
// `GET …/issues/{issue}/comments`, `…/comments/{comment}` and `…/activity`, and `POST`, `PATCH` and `DELETE` on a
// comment do. A new or edited comment reaches the session on its issue and the owner's bell from the Nuxt server, which
// knows the sessions: the reply says which (`Handoff`), and the router passes it on. The issue writes that lean on the
// same rails and activity are here too: claiming one and letting it go (`claimIssue`, `releaseIssue`) and deleting it
// (`deleteIssue`).
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::docs::{js, stamp, Actor, Effects};
use crate::error::{ApiError, Result};
use crate::migrate::actor_id;
use crate::people::Who;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::collections::HashMap;

/// What a person's own words on comment `o` are: the owner's, or a member's (`PERSONS_WORDS`, ORR-658).
const SINCE: &str = "EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND (o.owned = 1 OR (o.person IS NOT NULL AND o.by_agent = 0)) AND o.id > c.id)";

pub(crate) fn columns() -> String {
    format!(
        "CAST(c.id AS BIGINT) AS id, c.issue, c.body, c.asks, c.created_by, c.session_name, CAST(c.owned AS BIGINT) AS owned, c.created_at, c.updated_at, \
         CAST(CASE WHEN {SINCE} THEN 1 ELSE 0 END AS BIGINT) AS answered"
    )
}

/// A comment as the store gives it (`commentOf`): `answered` only with `asks`, `session_name` only with one.
pub(crate) fn comment_of(row: &AnyRow) -> Map<String, Value> {
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

/// What a comment's body may hold (`COMMENT_FIELDS`), and what `asks` may be (`ASKS`).
const COMMENT_FIELDS: [&str; 2] = ["body", "asks"];
const ASKS: [&str; 2] = ["decision", "feedback"];

/// A comment's body as `checkInput` takes it against `COMMENT_FIELDS`: `body` a string that isn't blank, and `asks` one
/// of `ASKS` or null. `partial` is an edit, where `body` may be left out. Each is `None` when it isn't sent, and `asks`
/// is `Some(None)` sent as null.
fn check_comment_input(body: &Value, partial: bool) -> Result<(Option<String>, Option<Option<String>>)> {
    let Some(object) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
    let mut problems = vec![];
    for key in object.keys() {
        if !COMMENT_FIELDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", COMMENT_FIELDS.join(", ")));
        }
    }
    let text = match object.get("body") {
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
    let asks = match object.get("asks") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(asks)) if ASKS.contains(&asks.as_str()) => Some(Some(asks.clone())),
        Some(Value::String(asks)) => {
            problems.push(format!("\"asks\" is \"{asks}\", not one of {} (or null)", ASKS.join(", ")));
            None
        }
        Some(other) => {
            problems.push(format!("\"asks\" should be a string, not {}", js(other)));
            None
        }
    };
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok((text, asks))
}

/// What a new comment leaves the Nuxt server to do, as only it knows the sessions (ORR-929): pass it on to the session
/// on its issue (`carry`: the owner's words, or a member's), and to the owner's bell (`notice`: an agent's).
#[derive(Debug, Default, PartialEq)]
pub struct Handoff {
    pub project: String,
    pub issue: String,
    pub comment: i64,
    pub carry: bool,
    pub notice: bool,
    /// The carried words replace ones a session may have read already (an edit).
    pub edited: bool,
}

/// A comment's row, as far as who may change it goes.
struct Whose {
    body: String,
    owned: bool,
    person: Option<String>,
    by_agent: bool,
}

pub struct Comments<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Comments<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Comments { conn, effects: Effects::default(), outbox: None }
    }

    async fn exists(&mut self, query: &str, project: &str, key: &str) -> Result<bool> {
        Ok(sqlx::query(&sql(query)).bind(project).bind(key).fetch_optional(&mut *self.conn).await?.is_some())
    }

    pub(crate) async fn project_uid(&mut self, project: &str) -> Result<String> {
        let row = sqlx::query(&sql("SELECT uid FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await?;
        row.map(|r| r.get::<Option<String>, _>("uid").unwrap_or_default()).ok_or_else(|| ApiError::not_found(format!("No project \"{project}\"")))
    }

    /// The issue's id, from its id, an id it had before (an alias), or the full form of either on this board (`issueId`).
    pub(crate) async fn issue_id(&mut self, project: &str, sent: &str) -> Result<String> {
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
    pub(crate) async fn issue_there(&mut self, project: &str, issue: &str) -> Result<()> {
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

    // Writing.

    /// A new comment on the issue: an agent's ask assigns the issue to the owner, and the owner's answer gives it back
    /// to the agent who asked. With people, an agent's ask waits on its own person, and only on an issue that's theirs.
    pub async fn create(&mut self, project: &str, sent: &str, body: &Value, actor: &Actor) -> Result<(Value, Handoff)> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let held: Option<String> = sqlx::query(&sql("SELECT assignee FROM issues WHERE project = ? AND id = ?"))
            .bind(project)
            .bind(&issue)
            .fetch_one(&mut *self.conn)
            .await?
            .get("assignee");
        let (text, asks) = check_comment_input(body, false)?;
        let (text, asks) = (text.unwrap_or_default(), asks.flatten());
        let owner = self.owner_id().await?;
        let asker = if actor.owner && held.as_deref() == Some(owner.as_str()) { self.open_asker(project, &issue).await? } else { None };
        let assignee = match if asks.is_some() { self.rails_for(actor).await? } else { None } {
            Some(Some(person)) if self.holder_of(held.as_deref()).await?.as_deref() == Some(person.as_str()) => Some(person),
            Some(_) => None,
            None if !actor.owner && asks.is_some() => Some(owner),
            None => asker,
        }
        .filter(|a| !a.is_empty());
        let (person, by_agent) = self.voice_of(actor).await?;
        let now = stamp();
        changes::begin(self.conn).await?;
        let done: Result<i64> = async {
            let id: i64 = sqlx::query(&sql(
                "INSERT INTO comments (project, issue, body, asks, created_by, session_name, owned, person, by_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS BIGINT) AS id",
            ))
            .bind(project)
            .bind(&issue)
            .bind(&text)
            .bind(asks.as_deref())
            .bind(&actor.name)
            .bind(actor.session.as_deref())
            .bind(i64::from(actor.owner))
            .bind(person.as_deref())
            .bind(i64::from(by_agent))
            .bind(&now)
            .bind(&now)
            .fetch_one(&mut *self.conn)
            .await?
            .get("id");
            if let Some(assignee) = &assignee {
                sqlx::query(&sql("UPDATE issues SET assignee = ? WHERE project = ? AND id = ?")).bind(assignee).bind(project).bind(&issue).execute(&mut *self.conn).await?;
                if held.as_deref() != Some(assignee.as_str()) {
                    self.record_assignee(project, &issue, actor, held.as_deref(), assignee).await?;
                }
            }
            self.touch_issue(project, &issue).await?;
            Ok(id)
        }
        .await;
        self.effects.changed = vec![project.into()];
        match &asks {
            Some(asks) => self.effects.tell_change("comment.asks", project, &issue, None, Some(asks)),
            None => self.effects.tell("comment.added", project, &issue),
        }
        let id = changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let handoff = Handoff {
            project: project.into(),
            issue: issue.clone(),
            comment: id,
            carry: actor.owner || actor.person.is_some(),
            notice: !actor.owner,
            edited: false,
        };
        Ok((self.comment(project, &issue, id).await?, handoff))
    }

    /// Edits the comment's words or what it asks: the owner's only by them, and a member's (or their agents') only by
    /// them or the owner (`updateComment`). New words by the comment's own person go to the session on the issue too, as
    /// it may have read the first ones (`Handoff`, `edited`).
    pub async fn update(&mut self, project: &str, sent: &str, id: i64, body: &Value, actor: &Actor) -> Result<(Value, Option<Handoff>)> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let whose = self.whose(project, &issue, id).await?;
        let action = format!("Editing comment {id}");
        if whose.owned && !actor.owner {
            return Err(ApiError::refused_for("issues.delete", format!("{action} is the owner's call: comment {id} was made by the owner")));
        }
        self.leave_their_words(&whose, actor, &action).await?;
        let (text, asks) = check_comment_input(body, true)?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let mut set = vec![];
            if text.is_some() {
                set.push("body = ?");
            }
            if asks.is_some() {
                set.push("asks = ?");
            }
            set.push("updated_at = ?");
            let query = format!("UPDATE comments SET {} WHERE id = ?", set.join(", "));
            let query = sql(&query);
            let mut update = sqlx::query(&query);
            if let Some(text) = &text {
                update = update.bind(text);
            }
            if let Some(asks) = &asks {
                update = update.bind(asks.as_deref());
            }
            update.bind(stamp()).bind(id).execute(&mut *self.conn).await?;
            self.touch_issue(project, &issue).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let theirs = (actor.owner && whose.owned) || (actor.person.is_some() && !whose.by_agent && whose.person == actor.person);
        let carry = theirs && text.as_ref().is_some_and(|t| *t != whose.body);
        let handoff = carry.then(|| Handoff { project: project.into(), issue: issue.clone(), comment: id, carry: true, notice: false, edited: true });
        Ok((self.comment(project, &issue, id).await?, handoff))
    }

    /// Deletes the comment: the owner's only by them, and a member's (or their agents') only by them or the owner.
    pub async fn delete(&mut self, project: &str, sent: &str, id: i64, actor: &Actor) -> Result<()> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let whose = self.whose(project, &issue, id).await?;
        let action = format!("Deleting comment {id}");
        if whose.owned && !actor.owner {
            return Err(ApiError::refused_for("issues.delete", format!("{action} is the owner's call: comment {id} was made by the owner")));
        }
        self.leave_their_words(&whose, actor, &action).await?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql("DELETE FROM comments WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
            self.touch_issue(project, &issue).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    // Claiming.

    /// A person taking up an issue themselves (`claimIssue`, ORR-657), or an agent its person's: their own, or one that's
    /// nobody's, which it assigns to them; the owner's on anyone's, which takes it over. 409 naming the holder otherwise.
    pub async fn claim(&mut self, project: &str, sent: &str, actor: &Actor) -> Result<String> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let (held, claimed) = self.claim_of(project, &issue).await?;
        let rails = self.rails_for(actor).await?;
        let person = if actor.owner {
            Some(self.owner_id().await?)
        } else if let Some(person) = &actor.person {
            Some(person.clone())
        } else {
            match &rails {
                Some(person) => person.clone(),
                None => Some(self.owner_id().await?),
            }
        };
        let holder = self.holder_of(held.as_deref()).await?;
        // Only the owner takes one over, and only a person assigns themselves what's nobody's.
        if let Some(rails) = &rails {
            if (person.is_none() || holder != person) && !(actor.person.is_some() && holder.is_none()) {
                self.must_hold(rails.as_deref(), &issue, held.as_deref(), "take it up").await?;
            }
        }
        let assignee = if holder == person { held.clone() } else { person.clone() };
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let guard = if actor.owner { "" } else { " AND coalesce(assignee, '') = ?" };
            let query = format!("UPDATE issues SET assignee = ?, claimed_by = ?, claimed_at = ?, claimed_session = NULL WHERE project = ? AND id = ?{guard}");
            let query = sql(&query);
            let mut update = sqlx::query(&query).bind(assignee.clone()).bind(person.clone()).bind(stamp()).bind(project).bind(&issue);
            if !actor.owner {
                update = update.bind(held.clone().unwrap_or_default());
            }
            if update.execute(&mut *self.conn).await?.rows_affected() == 0 {
                return Err(ApiError::conflict(format!("{issue} has just been reassigned; read it again")));
            }
            if assignee != held {
                self.record_field(project, &issue, actor, "assignee", held.as_deref(), assignee.as_deref()).await?;
            }
            if person != claimed {
                self.record_field(project, &issue, actor, "claim", claimed.as_deref(), person.as_deref()).await?;
            }
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        Ok(issue)
    }

    /// Lets go of a claim, which leaves the issue assigned (`releaseIssue`): its holder's, or the owner's on anyone's.
    pub async fn release(&mut self, project: &str, sent: &str, actor: &Actor) -> Result<String> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let Some(claimed) = self.claim_of(project, &issue).await?.1.filter(|c| !c.is_empty()) else { return Ok(issue) };
        let rails = self.rails_for(actor).await?;
        let person = if actor.owner { Some(self.owner_id().await?) } else { actor.person.clone().or_else(|| rails.clone().flatten()) };
        if rails.is_some() && person.as_deref() != Some(claimed.as_str()) {
            return Err(ApiError::conflict(format!("{issue} is held by {claimed}, so only they or the owner can let it go")));
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql("UPDATE issues SET claimed_by = NULL, claimed_at = NULL, claimed_session = NULL, updated_at = ? WHERE project = ? AND id = ?"))
                .bind(stamp())
                .bind(project)
                .bind(&issue)
                .execute(&mut *self.conn)
                .await?;
            self.record_field(project, &issue, actor, "claim", Some(&claimed), None).await?;
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        Ok(issue)
    }

    // Deleting.

    /// Deletes the issue, its sub-issues and comments with it (`deleteIssue`): an agent's only when every one is its
    /// person's, and none the owner made. What names them without a foreign key lets go of them (`issuesMoved`).
    pub async fn delete_issue(&mut self, project: &str, sent: &str, actor: &Actor) -> Result<()> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let subtree = self.subtree(project, &issue).await?;
        if let Some(rails) = self.rails_for(actor).await? {
            for id in &subtree {
                let held = self.claim_of(project, id).await?.0;
                self.must_hold(rails.as_deref(), id, held.as_deref(), "delete it").await?;
            }
        }
        if !actor.owner {
            let owned = self.owned_under(project, &subtree).await?;
            if !owned.is_empty() {
                let shown = if owned.len() > 4 { [owned[..3].to_vec(), vec![format!("{} more", owned.len() - 3)]].concat() } else { owned.clone() };
                let was = if owned.len() == 1 { "was" } else { "were" };
                return Err(ApiError::refused_for(
                    "issues.delete",
                    format!("Deleting {issue} is the owner's call: {} {was} made by the owner", shown.join(", ")),
                ));
            }
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            for id in &subtree {
                sqlx::query(&sql("DELETE FROM issue_aliases WHERE project = ? AND issue = ?")).bind(project).bind(id).execute(&mut *self.conn).await?;
            }
            for id in &subtree {
                sqlx::query(&sql("DELETE FROM signals WHERE project = ? AND issue = ?")).bind(project).bind(id).execute(&mut *self.conn).await?;
                self.drop_blocker(project, id, &subtree).await?;
                sqlx::query(&sql("DELETE FROM issue_links WHERE (project = ? AND issue = ?) OR (on_project = ? AND on_issue = ?)"))
                    .bind(project)
                    .bind(id)
                    .bind(project)
                    .bind(id)
                    .execute(&mut *self.conn)
                    .await?;
                sqlx::query(&sql("UPDATE schedule_runs SET issue = NULL WHERE issue = ? AND schedule IN (SELECT id FROM schedules WHERE project = ?)"))
                    .bind(id)
                    .bind(project)
                    .execute(&mut *self.conn)
                    .await?;
            }
            sqlx::query(&sql("DELETE FROM issues WHERE project = ? AND id = ?")).bind(project).bind(&issue).execute(&mut *self.conn).await?;
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        self.effects.tell("issue.deleted", project, &issue);
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// The issue's id and every id under it, depth first (`subtree`).
    pub(crate) async fn subtree(&mut self, project: &str, id: &str) -> Result<Vec<String>> {
        let mut out = vec![id.to_string()];
        let children: Vec<String> = sqlx::query(&sql("SELECT id FROM issues WHERE project = ? AND parent = ?"))
            .bind(project)
            .bind(id)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| r.get("id"))
            .collect();
        for child in children {
            out.extend(Box::pin(self.subtree(project, &child)).await?);
        }
        Ok(out)
    }

    /// The owner's issues and comments among these issues (`ownedUnder`).
    async fn owned_under(&mut self, project: &str, issues: &[String]) -> Result<Vec<String>> {
        let marks = vec!["?"; issues.len()].join(", ");
        let mut out = vec![];
        let query = format!("SELECT id FROM issues WHERE project = ? AND owned = 1 AND id IN ({marks})");
        let query = sql(&query);
        let mut find = sqlx::query(&query).bind(project);
        for id in issues {
            find = find.bind(id);
        }
        out.extend(find.fetch_all(&mut *self.conn).await?.iter().map(|r| r.get::<String, _>("id")));
        let query = format!("SELECT CAST(id AS BIGINT) AS id, issue FROM comments WHERE project = ? AND owned = 1 AND issue IN ({marks})");
        let query = sql(&query);
        let mut find = sqlx::query(&query).bind(project);
        for id in issues {
            find = find.bind(id);
        }
        out.extend(find.fetch_all(&mut *self.conn).await?.iter().map(|r| format!("comment {} on {}", r.get::<i64, _>("id"), r.get::<String, _>("issue"))));
        Ok(out)
    }

    /// Each issue depending on `id`, which is going with `going`, without it in its activity as a `depends` change
    /// (`dropBlocker`, ORR-601): the dispatch reads that, and hands one out that it freed.
    async fn drop_blocker(&mut self, project: &str, id: &str, going: &[String]) -> Result<()> {
        let dependents: Vec<(String, String)> = sqlx::query(&sql("SELECT project, issue FROM issue_links WHERE on_project = ? AND on_issue = ?"))
            .bind(project)
            .bind(id)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| (r.get("project"), r.get("issue")))
            .collect();
        let orrery = Actor { name: "orrery".into(), owner: false, session: None, person: None, named: None, asked: false, untrusted: false, chat: false };
        for (on, dependent) in dependents {
            if on == project && going.contains(&dependent) {
                continue;
            }
            let before: Vec<(String, String)> = sqlx::query(&sql(
                "SELECT on_project AS project, on_issue AS id FROM issue_links WHERE project = ? AND issue = ? ORDER BY created_at, on_project, on_issue",
            ))
            .bind(&on)
            .bind(&dependent)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| (r.get("project"), r.get("id")))
            .collect();
            let refs = |list: Vec<&(String, String)>| {
                (!list.is_empty())
                    .then(|| json!(list.iter().map(|(p, i)| if *p == on { i.clone() } else { format!("{p}/{i}") }).collect::<Vec<_>>()).to_string())
            };
            let from = refs(before.iter().collect());
            let to = refs(before.iter().filter(|(p, i)| p != project || i != id).collect());
            if from != to {
                self.record_field(&on, &dependent, &orrery, "depends", from.as_deref(), to.as_deref()).await?;
            }
        }
        Ok(())
    }

    /// The issue's assignee and who has claimed it.
    async fn claim_of(&mut self, project: &str, issue: &str) -> Result<(Option<String>, Option<String>)> {
        let row = sqlx::query(&sql("SELECT assignee, claimed_by FROM issues WHERE project = ? AND id = ?"))
            .bind(project)
            .bind(issue)
            .fetch_one(&mut *self.conn)
            .await?;
        Ok((row.get("assignee"), row.get("claimed_by")))
    }

    /// Refuses an agent an issue that isn't its person's, naming who has it (`mustHold`), or one that names nobody.
    pub(crate) async fn must_hold(&mut self, person: Option<&str>, issue: &str, assignee: Option<&str>, what: &str) -> Result<()> {
        let Some(person) = person else {
            return Err(ApiError::conflict(format!(
                "This session names nobody on this orrery, so it can read and comment, but can't {what}. Set ORRERY_PERSON to your id (GET /api/people) where you start Claude Code, or send Orrery-Person."
            )));
        };
        let holder = self.holder_of(assignee).await?;
        if holder.as_deref() == Some(person) {
            return Ok(());
        }
        let (with, instead) = match &holder {
            Some(holder) => (format!("assigned to {holder}"), "comment on it instead, or pick another issue"),
            None => ("assigned to nobody".to_string(), "a person has to assign it first"),
        };
        Err(ApiError::conflict(format!("{issue} is {with}, and this session is {person}'s, so it can't {what}; {instead}")))
    }

    pub(crate) async fn touch_project(&mut self, project: &str) -> Result<()> {
        sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(stamp()).bind(project).execute(&mut *self.conn).await?;
        Ok(())
    }

    async fn whose(&mut self, project: &str, issue: &str, id: i64) -> Result<Whose> {
        let row = sqlx::query(&sql(
            "SELECT body, CAST(owned AS BIGINT) AS owned, person, CAST(by_agent AS BIGINT) AS by_agent FROM comments WHERE project = ? AND issue = ? AND id = ?",
        ))
        .bind(project)
        .bind(issue)
        .bind(id)
        .fetch_optional(&mut *self.conn)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("No comment {id} on {issue}")))?;
        Ok(Whose { body: row.get("body"), owned: row.get::<i64, _>("owned") != 0, person: row.get("person"), by_agent: row.get::<i64, _>("by_agent") != 0 })
    }

    /// A member's comment is theirs, as the owner's are the owner's: only they and the owner change it. Their agents'
    /// are theirs too, which only they, their agents and the owner change (`leaveTheirWords`).
    async fn leave_their_words(&mut self, whose: &Whose, actor: &Actor, action: &str) -> Result<()> {
        let Some(person) = &whose.person else { return Ok(()) };
        if !whose.by_agent {
            if !actor.owner && actor.person.as_deref() != Some(person.as_str()) {
                return Err(ApiError::refused_for("issues.delete", format!("{action} is {person}'s call: they wrote it")));
            }
            return Ok(());
        }
        if let Some(rails) = self.rails_for(actor).await? {
            if actor.person.clone().or(rails).as_deref() != Some(person.as_str()) {
                return Err(ApiError::refused_for("issues.delete", format!("{action} is {person}'s call: their agent wrote it")));
            }
        }
        Ok(())
    }

    /// Who asked the issue's latest question the owner hasn't answered (`OPEN_ASK`).
    async fn open_asker(&mut self, project: &str, issue: &str) -> Result<Option<String>> {
        let query = format!("SELECT c.created_by FROM comments c WHERE c.project = ? AND c.issue = ? AND c.asks IS NOT NULL AND c.owned = 0 AND NOT {SINCE} ORDER BY c.id DESC LIMIT 1");
        let row = sqlx::query(&sql(&query)).bind(project).bind(issue).fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|r| r.get("created_by")))
    }

    /// The owner's id: what waits on them is assigned to it (`ownerId`).
    pub(crate) async fn owner_id(&mut self) -> Result<String> {
        let row = sqlx::query("SELECT id FROM people WHERE role = 'owner'").fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|r| r.get::<String, _>("id")).unwrap_or_else(|| "owner".into()))
    }

    /// The people here, by id.
    async fn people_here(&mut self) -> Result<Vec<String>> {
        let rows = sqlx::query("SELECT id FROM people WHERE removed_at IS NULL").fetch_all(&mut *self.conn).await?;
        Ok(rows.iter().map(|r| r.get("id")).collect())
    }

    /// Whose a session is (`personFor`): with one person, theirs; with more, the person it names, by name or id.
    pub(crate) async fn person_for(&mut self, named: &str) -> Result<Option<String>> {
        let here = self.people_here().await?;
        if here.len() < 2 {
            return Ok(Some(self.owner_id().await?));
        }
        let id = actor_id(named);
        Ok(here.into_iter().find(|p| !id.is_empty() && *p == id))
    }

    /// Whose a request is (`personOf`): the credential's person, the owner's own, their chat's the owner's, and a
    /// session's the person it names; an untrusted session's nobody's.
    pub(crate) async fn person_asking(&mut self, who: Option<&Who>, actor: &Actor) -> Result<Option<String>> {
        if actor.untrusted {
            return Ok(None);
        }
        if let Some(who) = who {
            return Ok(Some(who.person.clone()));
        }
        if actor.owner {
            return Ok(Some(actor.name.to_lowercase()));
        }
        if actor.chat {
            return Ok(Some(self.owner_id().await?));
        }
        self.person_for(actor.named.as_deref().unwrap_or(&actor.name)).await
    }

    /// Whose agent is asking, as `railsFor` has it: `None` when the rails don't hold it (the owner, their chat, what
    /// isn't a request, or one person here), else `Some` of the person it names, if any.
    pub(crate) async fn rails_for(&mut self, actor: &Actor) -> Result<Option<Option<String>>> {
        if !actor.asked || actor.owner || actor.chat || self.people_here().await?.len() < 2 {
            return Ok(None);
        }
        if actor.untrusted {
            return Ok(Some(None));
        }
        Ok(Some(self.person_for(actor.named.as_deref().unwrap_or(&actor.name)).await?))
    }

    /// The person an issue is assigned to (`holderOf`): `claude` counts as the owner's, and one who isn't a person is nobody.
    async fn holder_of(&mut self, assignee: Option<&str>) -> Result<Option<String>> {
        let id = assignee.unwrap_or_default().to_lowercase();
        if id.is_empty() {
            return Ok(None);
        }
        if id == "claude" {
            return Ok(Some(self.owner_id().await?));
        }
        let here = sqlx::query(&sql("SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL")).bind(&id).fetch_optional(&mut *self.conn).await?;
        Ok(here.map(|_| id))
    }

    /// Whose a comment is (`voiceOf`, ORR-658): the person's own words, or one of their agents', or nobody's.
    async fn voice_of(&mut self, actor: &Actor) -> Result<(Option<String>, bool)> {
        if actor.owner {
            return Ok((Some(self.owner_id().await?), false));
        }
        if let Some(person) = &actor.person {
            return Ok((Some(person.clone()), false));
        }
        let person = if actor.asked && !actor.untrusted { self.person_for(actor.named.as_deref().unwrap_or(&actor.name)).await? } else { None };
        Ok((person, true))
    }

    /// Notes the issue's new assignee in its activity, and tells it (`record`).
    async fn record_assignee(&mut self, project: &str, issue: &str, actor: &Actor, before: Option<&str>, after: &str) -> Result<()> {
        self.record_field(project, issue, actor, "assignee", before, Some(after)).await
    }

    /// Notes a field's change in the issue's activity, and tells it as `issue.<field>` (`record`).
    pub(crate) async fn record_field(
        &mut self,
        project: &str,
        issue: &str,
        actor: &Actor,
        field: &str,
        before: Option<&str>,
        after: Option<&str>,
    ) -> Result<()> {
        sqlx::query(&sql(
            "INSERT INTO issue_events (project, issue, field, \"before\", \"after\", created_by, session_name, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ))
        .bind(project)
        .bind(issue)
        .bind(field)
        .bind(before)
        .bind(after)
        .bind(&actor.name)
        .bind(actor.session.as_deref())
        .bind(i64::from(actor.owner))
        .bind(stamp())
        .execute(&mut *self.conn)
        .await?;
        self.effects.tell_change(&format!("issue.{field}"), project, issue, before, after);
        Ok(())
    }

    async fn touch_issue(&mut self, project: &str, issue: &str) -> Result<()> {
        let now = stamp();
        sqlx::query(&sql("UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?"))
            .bind(&now)
            .bind(project)
            .bind(issue)
            .execute(&mut *self.conn)
            .await?;
        sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(&now).bind(project).execute(&mut *self.conn).await?;
        Ok(())
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
