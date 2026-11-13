// An issue's comments and activity (ORR-927): what `listComments`, `comment`, `listActivity`, `createComment`,
// `updateComment` and `deleteComment` in web/server/store/comments.ts do, on the same tables, answering as
// `GET …/issues/{issue}/comments`, `…/comments/{comment}` and `…/activity`, and `POST`, `PATCH` and `DELETE` on a
// comment do. A new or edited comment reaches the session on its issue and the owner's bell from the Nuxt server, which
// knows the sessions: the reply says which (`Handoff`), and the router passes it on. They're writes on an issue, so
// they're methods of `IssueWrites` (issue_writes.rs), with the rails they share.
use crate::board::issue_writes::IssueWrites;
use crate::changes;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{js, stamp, Actor};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::Row;
use std::collections::HashMap;

/// Who orrery's own comments are by (`ORRERY` in web/server/store/schema.ts).
const ORRERY: &str = "orrery";

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
    /// Said to the session, but it starts none (`startsNone`): the owner's rejection of a proposal (ORR-606).
    pub quiet: bool,
}

/// A comment's row, as far as who may change it goes.
pub(crate) struct Whose {
    pub body: String,
    pub owned: bool,
    pub person: Option<String>,
    pub by_agent: bool,
}

impl IssueWrites<'_> {
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
            // An agent's comment goes to the owner's bell (`notice`), which the local app pushes to open pages (ORR-1174).
            if !actor.owner {
                changes::row(self.conn, "notice", project, &id.to_string(), Some(serde_json::json!({"issue": issue}))).await?;
            }
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
            quiet: false,
        };
        Ok((self.comment(project, &issue, id).await?, handoff))
    }

    /// orrery's own word on an issue (ORR-1094), as `systemComment` and `systemNote` in web/server/store/comments.ts
    /// write it: a comment by `orrery`, nobody's words but its own, so nobody's bell hears it. `wakes` passes it on to
    /// the session on the issue, as a pull request's news does, unless the issue is closed, where there's no work left
    /// to wake anyone for; a note (why a schedule moved it) wakes nobody. Only the Nuxt server's own work sends it.
    pub async fn said(&mut self, project: &str, sent: &str, body: &Value) -> Result<(Value, Handoff)> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let text = match body.get("body") {
            Some(Value::String(text)) if !text.trim().is_empty() => text.clone(),
            _ => return Err(ApiError::bad_request("Send \"body\": orrery's words, as a string")),
        };
        let wakes = match body.get("wakes") {
            None | Some(Value::Bool(false)) => false,
            Some(Value::Bool(true)) => true,
            Some(other) => return Err(ApiError::bad_request(format!("\"wakes\" should be true or false, not {}", js(other)))),
        };
        let kind: Option<String> = sqlx::query(&sql("SELECT s.kind FROM issues i JOIN statuses s ON s.id = i.status WHERE i.project = ? AND i.id = ?"))
            .bind(project)
            .bind(&issue)
            .fetch_optional(&mut *self.conn)
            .await?
            .map(|row| row.get("kind"));
        let closed = kind.as_deref().is_some_and(|k| k == "done" || k == "canceled");
        let now = stamp();
        changes::begin(self.conn).await?;
        let done: Result<i64> = async {
            let id: i64 = sqlx::query(&sql(
                "INSERT INTO comments (project, issue, body, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING CAST(id AS BIGINT) AS id",
            ))
            .bind(project)
            .bind(&issue)
            .bind(&text)
            .bind(ORRERY)
            .bind(&now)
            .bind(&now)
            .fetch_one(&mut *self.conn)
            .await?
            .get("id");
            self.touch_issue(project, &issue).await?;
            Ok(id)
        }
        .await;
        self.effects.changed = vec![project.into()];
        self.effects.tell("comment.added", project, &issue);
        let id = changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let handoff = Handoff { project: project.into(), issue: issue.clone(), comment: id, carry: wakes && !closed, ..Handoff::default() };
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
        let handoff =
            carry.then(|| Handoff { project: project.into(), issue: issue.clone(), comment: id, carry: true, notice: false, edited: true, quiet: false });
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
    pub(crate) async fn leave_their_words(&mut self, whose: &Whose, actor: &Actor, action: &str) -> Result<()> {
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

    /// Whose a comment is (`voiceOf`, ORR-658): the person's own words, or one of their agents', or nobody's.
    pub(crate) async fn voice_of(&mut self, actor: &Actor) -> Result<(Option<String>, bool)> {
        if actor.owner {
            return Ok((Some(self.owner_id().await?), false));
        }
        if let Some(person) = &actor.person {
            return Ok((Some(person.clone()), false));
        }
        let person = if actor.asked && !actor.untrusted { self.person_for(actor.named.as_deref().unwrap_or(&actor.name)).await? } else { None };
        Ok((person, true))
    }
}

#[cfg(test)]
#[path = "comments_tests.rs"]
mod tests;
