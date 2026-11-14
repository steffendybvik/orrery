// The owner's chats, reading them as they're kept (ORR-951): the `chats` table, as `chatsLoaded` reads it back into
// web/server/utils/chats.ts, and `listChats` and `readChat` answer from it. Written ahead: the Nuxt server answers from
// its memory, which is ahead of the table, as a chat's change is saved just after it, and why a launcher couldn't start
// one (`problem`) is never kept. Running a chat stays the local app's, as its session is; what it keeps of one is its
// row, written here too (`keepChat`), for the local app to hand over once it's swapped in. A chat's messages are rows
// of their own (`chat_messages`, ORR-1100), each added here, which gives it its id, and changed one at a time (a
// request's answer, its drift), so the chat's requests can be asked and answered here too.
use crate::board::issue_edits::resolve_status;
use crate::board::issue_writes::IssueWrites;
use crate::board::issues::Issues;
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::work::event_log::EventLog;
use crate::write::{Actor, Effects};
use serde_json::{json, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

/// A chat as kept: its JSON, with the row's project (`{...JSON.parse(row.chat), project: row.project}`) and its
/// messages, oldest first.
fn chat_of(row: &AnyRow, messages: Vec<Value>) -> Result<Value> {
    let mut chat: Value = serde_json::from_str(&row.get::<String, _>("chat")).map_err(|_| ApiError::internal("a chat kept as JSON"))?;
    let Some(fields) = chat.as_object_mut() else { return Err(ApiError::internal("a chat kept as an object")) };
    fields.insert("project".into(), json!(row.get::<String, _>("project")));
    fields.insert("messages".into(), Value::Array(messages));
    Ok(chat)
}

/// A message as kept: its JSON, with the row's id and time.
fn message_of(row: &AnyRow) -> Result<Value> {
    let mut message: Value = serde_json::from_str(&row.get::<String, _>("message")).map_err(|_| ApiError::internal("a chat's message kept as JSON"))?;
    let Some(fields) = message.as_object_mut() else { return Err(ApiError::internal("a chat's message kept as an object")) };
    fields.insert("id".into(), json!(row.get::<i64, _>("id")));
    fields.insert("at".into(), json!(row.get::<String, _>("at")));
    Ok(message)
}

/// What's wrong with a message sent to keep: who it's from, its words and its uploads, as the chat says them.
fn message_problems(sent: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut problems = vec![];
    if !matches!(sent.get("from").and_then(Value::as_str), Some("owner" | "claude")) {
        problems.push("\"from\" should be \"owner\" or \"claude\"".into());
    }
    if !sent.get("text").is_some_and(Value::is_string) {
        problems.push("\"text\" should be a string".into());
    }
    if !sent.get("images").and_then(Value::as_array).is_some_and(|i| i.iter().all(Value::is_string)) {
        problems.push("\"images\" should be a list of upload ids".into());
    }
    problems
}

/// The App settings the chat may ask to change (`CHAT_SETTINGS`); the rest are the owner's alone.
const CHAT_SETTINGS: [&str; 5] = ["tracker", "tint", "restrict_proposals", "handle", "advanced"];

/// What of a release the chat may ask to set (`CHAT_RELEASE_FIELDS`); removing one stays the owner's.
const CHAT_RELEASE_FIELDS: [&str; 6] = ["version", "branch", "notes", "position", "frozen_on", "shipped_on"];

/// What the chat's offer of an issue can say (`CHAT_ISSUE_FIELDS`).
const CHAT_ISSUE_FIELDS: [&str; 5] = ["title", "notes", "priority", "labels", "milestone"];

/// The most issues one move asks for (`MOVE_AT_MOST`).
const MOVE_AT_MOST: usize = 50;

/// What the chat's move set off (`ask_move`): its message in the chat (null when a move failed part-way), the effects of
/// the issues it moved and the event log's line, each recorded in its own transaction, and the issues it made urgent
/// open work, for the Nuxt server to push to the sessions.
pub struct Moved {
    pub message: Value,
    pub project: String,
    pub set_off: Effects,
    pub urgent: Vec<String>,
}

/// A JSON value as text: a string as it is, anything else as JSON.
fn text_of(value: &Value) -> String {
    value.as_str().map(String::from).unwrap_or_else(|| if value.is_null() { String::new() } else { value.to_string() })
}

/// Whether the owner's message names one of `ids`, as a whole id in its words, or was sent from that issue's page
/// (`saidIssue`).
pub(crate) fn said_issue(words: &str, page: Option<&str>, ids: &[String]) -> bool {
    ids.iter().any(|issue| {
        let plain: String = issue.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
        // JavaScript's `\w` is ASCII's.
        let whole = regex::RegexBuilder::new(&format!(r"(^|[^0-9A-Za-z_-]){}($|[^0-9A-Za-z_-])", regex::escape(&plain))).case_insensitive(true).build();
        whole.is_ok_and(|r| r.is_match(words)) || page.is_some_and(|p| p.to_lowercase().ends_with(&format!("/issues/{}", issue.to_lowercase())))
    })
}

/// Where a move puts its issues, as a phrase (`moveTo`): "in done, assigned to claude".
fn move_to(to: &serde_json::Map<String, Value>) -> String {
    let status = to.get("status").map(|s| format!("in {}", text_of(s)));
    let assignee = to.get("assignee").map(|a| if a.is_null() { "unassigned".to_string() } else { format!("assigned to {}", text_of(a)) });
    [status, assignee].into_iter().flatten().collect::<Vec<_>>().join(", ")
}

/// Adds what `more` set off to `effects`, each project and chat once.
pub(crate) fn absorb(effects: &mut Effects, more: Effects) {
    for project in more.changed {
        if !effects.changed.contains(&project) {
            effects.changed.push(project);
        }
    }
    for chat in more.chats {
        if !effects.chats.contains(&chat) {
            effects.chats.push(chat);
        }
    }
    effects.told.extend(more.told);
    effects.logged.extend(more.logged);
}

/// A place among the releases, as a chat's request shows it (`place`): "the top", "2nd from the top".
fn place(index: f64) -> String {
    if index <= 0.0 {
        return "the top".into();
    }
    let n = index.trunc() as i64 + 1;
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{n}{suffix} from the top")
}

pub struct Chats<'c> {
    conn: &'c mut AnyConnection,
    pub effects: Effects,
    pub outbox: Option<Outbox>,
}

impl<'c> Chats<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Chats { conn, effects: Effects::default(), outbox: None }
    }

    /// Keeps the chat as it is now (`keepChat`): the whole chat, as the local app holds it, but why its launcher
    /// couldn't start it. Its project and start stay as first kept.
    pub async fn keep(&mut self, id: &str, body: &Value) -> Result<()> {
        let Some(sent) = body.as_object() else { return Err(ApiError::bad_request("The body should be the chat, a JSON object")) };
        let mut problems = vec![];
        if sent.get("id").and_then(Value::as_str) != Some(id) {
            problems.push(format!("\"id\" should be the chat's, \"{id}\""));
        }
        for key in ["project", "started_at"] {
            if !sent.get(key).is_some_and(Value::is_string) {
                problems.push(format!("\"{key}\" should be a string"));
            }
        }
        let ended_at = match sent.get("ended_at") {
            None | Some(Value::Null) => None,
            Some(Value::String(at)) => Some(at.clone()),
            Some(_) => {
                problems.push("\"ended_at\" should be a string".into());
                None
            }
        };
        if !problems.is_empty() {
            return Err(ApiError::problems(problems));
        }
        let mut kept = sent.clone();
        kept.shift_remove("problem");
        // Its messages are rows of their own, added and changed one at a time.
        kept.shift_remove("messages");
        let text = |key: &str| sent[key].as_str().unwrap_or_default().to_string();
        changes::begin(self.conn).await?;
        let done = sqlx::query(&sql(
            "INSERT INTO chats (id, project, started_at, ended_at, chat) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ended_at = excluded.ended_at, chat = excluded.chat",
        ))
        .bind(id)
        .bind(text("project"))
        .bind(text("started_at"))
        .bind(ended_at)
        .bind(Value::Object(kept).to_string())
        .execute(&mut *self.conn)
        .await
        .map(|_| ())
        .map_err(Into::into);
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Lets go of the chat's row (`keepChat` with `gone`): one that ended before anything was said, or deleted. Its
    /// messages go with it.
    pub async fn forget(&mut self, id: &str) -> Result<()> {
        changes::begin(self.conn).await?;
        let done = self.forget_in(id).await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn forget_in(&mut self, id: &str) -> Result<()> {
        sqlx::query(&sql("DELETE FROM chat_messages WHERE chat = ?")).bind(id).execute(&mut *self.conn).await?;
        sqlx::query(&sql("DELETE FROM chats WHERE id = ?")).bind(id).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// Adds a message to the chat (`add`): who it's from, its words and uploads, and what it asks, as the page reads it.
    /// It's given its id, the next after every chat's, and its time here. A 404 when the chat isn't kept.
    pub async fn add_message(&mut self, chat: &str, body: &Value) -> Result<Value> {
        let Some(sent) = body.as_object() else { return Err(ApiError::bad_request("The body should be the message, a JSON object")) };
        let problems = message_problems(sent);
        if !problems.is_empty() {
            return Err(ApiError::problems(problems));
        }
        let mut message = sent.clone();
        message.shift_remove("id");
        message.shift_remove("at");
        changes::begin(self.conn).await?;
        let done = self.add_in(chat, message).await;
        self.effects.chats.push(chat.to_string());
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn add_in(&mut self, chat: &str, message: serde_json::Map<String, Value>) -> Result<Value> {
        self.known(chat).await?;
        let last: i64 = sqlx::query("SELECT CAST(COALESCE(MAX(id), 0) AS BIGINT) AS n FROM chat_messages").fetch_one(&mut *self.conn).await?.get("n");
        let id = last + 1;
        let at = crate::write::stamp();
        sqlx::query(&sql("INSERT INTO chat_messages (chat, id, at, message) VALUES (?, ?, ?, ?)"))
            .bind(chat)
            .bind(id)
            .bind(&at)
            .bind(Value::Object(message.clone()).to_string())
            .execute(&mut *self.conn)
            .await?;
        let mut said = serde_json::Map::new();
        said.insert("id".into(), json!(id));
        said.insert("at".into(), json!(at));
        said.extend(message);
        Ok(Value::Object(said))
    }

    /// Changes the chat's message `id` to `body` (`changed`): a request answered or expired, what drifted on it. Its id
    /// and time stay. A 404 when there's no such message.
    pub async fn change_message(&mut self, chat: &str, id: i64, body: &Value) -> Result<Value> {
        let Some(sent) = body.as_object() else { return Err(ApiError::bad_request("The body should be the message, a JSON object")) };
        let problems = message_problems(sent);
        if !problems.is_empty() {
            return Err(ApiError::problems(problems));
        }
        let mut message = sent.clone();
        message.shift_remove("id");
        message.shift_remove("at");
        changes::begin(self.conn).await?;
        let done = self.change_in(chat, id, message).await;
        self.effects.chats.push(chat.to_string());
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn change_in(&mut self, chat: &str, id: i64, message: serde_json::Map<String, Value>) -> Result<Value> {
        let changed = sqlx::query(&sql("UPDATE chat_messages SET message = ? WHERE chat = ? AND id = ?"))
            .bind(Value::Object(message).to_string())
            .bind(chat)
            .bind(id)
            .execute(&mut *self.conn)
            .await?;
        if changed.rows_affected() == 0 {
            return Err(ApiError::not_found(format!("No message {id} in chat {chat}")));
        }
        let row = sqlx::query(&sql("SELECT CAST(id AS BIGINT) AS id, at, message FROM chat_messages WHERE chat = ? AND id = ?"))
            .bind(chat)
            .bind(id)
            .fetch_one(&mut *self.conn)
            .await?;
        message_of(&row)
    }

    /// The chat's session answering (its `reply`, `reply` in web/server/utils/chats.ts): `{text}`, trimmed, added as its
    /// message, which the local app hears (ORR-1101). A 404 when the chat isn't running.
    pub async fn reply(&mut self, chat: &str, body: &Value) -> Result<Value> {
        let words = body.get("text").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
        if words.is_empty() {
            return Err(ApiError::bad_request("Send the answer as {\"text\": \"…\"}"));
        }
        let running: Option<String> =
            sqlx::query_scalar(&sql("SELECT id FROM chats WHERE id = ? AND ended_at IS NULL")).bind(chat).fetch_optional(&mut *self.conn).await?;
        if running.is_none() {
            return Err(ApiError::not_found(format!("No chat {chat}: it has ended")));
        }
        let mut message = serde_json::Map::new();
        message.insert("from".into(), json!("claude"));
        message.insert("text".into(), json!(words));
        message.insert("images".into(), json!([]));
        changes::begin(self.conn).await?;
        let done = self.add_in(chat, message).await;
        self.effects.chats.push(chat.to_string());
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// The chat's session asking to change one App setting (its `update_settings`, `askSetting`): `{setting, value,
    /// why?}`, checked as the settings would check it, kept as a request in the chat that saves nothing until the owner
    /// allows it, which the local app hears (ORR-1100). One it asked before for the same setting, still unanswered,
    /// expires. A 404 when the chat isn't running.
    pub async fn ask_setting(&mut self, chat: &str, body: &Value) -> Result<Value> {
        let setting = body.get("setting").and_then(Value::as_str).filter(|s| CHAT_SETTINGS.contains(s));
        let Some(setting) = setting else {
            return Err(ApiError::bad_request(format!(
                "Send {{setting, value}}, setting one of {}; the rest are the owner's to change on App settings",
                CHAT_SETTINGS.join(", ")
            )));
        };
        let Some(value) = body.get("value") else { return Err(ApiError::bad_request("Send the value to set as \"value\" (null for none)")) };
        let mut to = crate::work::settings::check_input(&json!({ setting: value }))?.remove(setting).unwrap_or(Value::Null);
        if setting == "handle" {
            if let Some(handle) = to.as_str() {
                to = json!(handle.to_lowercase());
            }
        }
        let from = crate::work::settings::Settings::new(&mut *self.conn).get().await?.get(setting).cloned().unwrap_or(Value::Null);
        let why = body.get("why").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
        changes::begin(self.conn).await?;
        let done = self.ask_setting_in(chat, setting, from, to, why).await;
        self.effects.chats.push(chat.to_string());
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn ask_setting_in(&mut self, chat: &str, setting: &str, from: Value, to: Value, why: String) -> Result<Value> {
        let ended: Option<Option<String>> =
            sqlx::query_scalar(&sql("SELECT ended_at FROM chats WHERE id = ?")).bind(chat).fetch_optional(&mut *self.conn).await?;
        if !matches!(ended, Some(None)) {
            return Err(ApiError::not_found(format!("No chat {chat}: it has ended")));
        }
        for mut asked in self.messages(Some(chat)).await?.remove(chat).unwrap_or_default() {
            if asked["request"]["state"] != "asked" || asked["request"]["setting"] != setting {
                continue;
            }
            asked["request"]["state"] = json!("expired");
            let id = asked["id"].as_i64().unwrap_or_default();
            let Value::Object(mut message) = asked else { continue };
            message.shift_remove("id");
            message.shift_remove("at");
            self.change_in(chat, id, message).await?;
        }
        let request = json!({"from": "claude", "text": why, "images": [], "request": {"setting": setting, "from": from, "to": to, "state": "asked"}});
        let Value::Object(message) = request else { unreachable!("a JSON object") };
        self.add_in(chat, message).await
    }

    /// The chat's session asking to make a schedule, or change schedule `id` (its `create_schedule` and
    /// `update_schedule`, `askSchedule`): `{schedule, id?, project?, why?}`, `schedule` the fields as Schedules takes
    /// them, on the project it names or else the chat's own. Checked as Schedules would check it for the owner, and kept
    /// as a request in the chat that saves nothing until they allow it, which the local app hears (ORR-1100). One it
    /// asked before for the same schedule, still unanswered, expires. A 404 when the chat isn't running.
    pub async fn ask_schedule(&mut self, chat: &str, body: &Value) -> Result<Value> {
        let own = self.running(chat).await?;
        let project = self.project_for(&own, body).await?;
        let mut request = crate::work::schedule_requests::ScheduleRequests::new(&mut *self.conn)
            .request(&project, body.get("schedule"), body.get("id"), "The owner's chat")
            .await?;
        if project != own {
            request["project"] = json!(project);
        }
        self.ask(chat, "schedule", "id", request, body).await
    }

    /// The chat's session asking to make a release, or change release `version` (its `create_release` and
    /// `update_release`, `askRelease`): `{release, version?, project?, why?}`, `release` the fields as Releases takes
    /// them, on the project it names or else the chat's own. Checked as Releases would check it, and kept as a request
    /// in the chat, each field from → to (a place as "2nd from the top"), that saves nothing until the owner allows it,
    /// which the local app hears (ORR-1100). One it asked before for the same release, still unanswered, expires. A 404
    /// when the chat isn't running.
    pub async fn ask_release(&mut self, chat: &str, body: &Value) -> Result<Value> {
        let own = self.running(chat).await?;
        let project = self.project_for(&own, body).await?;
        let fields = body.get("release").and_then(Value::as_object).filter(|f| !f.is_empty());
        let Some(fields) = fields else {
            return Err(ApiError::bad_request(format!(
                "Send {{release: {{…}}, version?}}: the fields to set, any of {}, and the version of the release to change one",
                CHAT_RELEASE_FIELDS.join(", ")
            )));
        };
        let refused = fields.keys().filter(|k| !CHAT_RELEASE_FIELDS.contains(&k.as_str())).cloned().collect::<Vec<_>>();
        if !refused.is_empty() {
            return Err(ApiError::forbidden(format!("The owner's chat sets a release's {}, not its {}", CHAT_RELEASE_FIELDS.join(", "), refused.join(", "))));
        }
        let version = match body.get("version") {
            None | Some(Value::Null) => None,
            Some(Value::String(v)) => Some(v.as_str()),
            Some(_) => return Err(ApiError::bad_request("Send \"version\" as the version of the release to change, or leave it out to make one")),
        };
        let fields = Value::Object(fields.clone());
        let current = crate::board::releases::Releases::new(&mut *self.conn).check(&project, &fields, version).await?;
        let shown = |field: &str, value: &Value| match value.as_f64() {
            Some(at) if field == "position" => json!(place(at)),
            _ => value.clone(),
        };
        let changes = fields
            .as_object()
            .into_iter()
            .flatten()
            .map(|(field, to)| match &current {
                Some(was) => json!({"field": field, "from": shown(field, was.get(field).unwrap_or(&Value::Null)), "to": shown(field, to)}),
                None => json!({"field": field, "to": shown(field, to)}),
            })
            .collect::<Vec<_>>();
        let named = version.or(fields["version"].as_str()).unwrap_or_default().to_string();
        let mut request = json!({"version": named, "change": current.is_some(), "changes": changes, "body": fields, "state": "asked"});
        if project != own {
            request["project"] = json!(project);
        }
        self.ask(chat, "release", "version", request, body).await
    }

    /// The chat's session offering to file an issue the owner didn't ask for (its `offer_issue`, `askIssue`, ORR-711):
    /// `{issue, project?, why?}`, `issue` its title, notes, priority, labels and milestone, checked as the issue routes
    /// check them, on the project it names or else the chat's own. Kept as an offer in the chat that files nothing until
    /// the owner presses File issue, which the local app hears (ORR-1100). One it offered before under the same title,
    /// still unanswered, expires. A 404 when the chat isn't running.
    pub async fn ask_issue(&mut self, chat: &str, body: &Value) -> Result<Value> {
        let own = self.running(chat).await?;
        let project = self.project_for(&own, body).await?;
        let Some(fields) = body.get("issue").and_then(Value::as_object) else {
            return Err(ApiError::bad_request(format!("Send {{issue: {{…}}}}: its {}", CHAT_ISSUE_FIELDS.join(", "))));
        };
        let refused = fields.keys().filter(|k| !CHAT_ISSUE_FIELDS.contains(&k.as_str())).cloned().collect::<Vec<_>>();
        if !refused.is_empty() {
            return Err(ApiError::forbidden(format!("The owner's chat offers an issue's {}, not its {}", CHAT_ISSUE_FIELDS.join(", "), refused.join(", "))));
        }
        let words = crate::board::issue_edits::check_new(&Value::Object(fields.clone()))?;
        let title = words.title.unwrap_or_default();
        if title.is_empty() {
            return Err(ApiError::bad_request("An issue needs a title"));
        }
        let mut request = json!({"title": title, "state": "asked"});
        if let Some(notes) = words.notes.flatten().filter(|n| !n.is_empty()) {
            request["notes"] = json!(notes);
        }
        if let Some(priority) = words.priority.flatten() {
            request["priority"] = json!(priority);
        }
        if let Some(labels) = words.labels.filter(|l| !l.is_empty()) {
            request["labels"] = json!(labels);
        }
        if let Some(milestone) = words.milestone.flatten() {
            request["milestone"] = json!(milestone);
        }
        if project != own {
            request["project"] = json!(project);
        }
        self.ask(chat, "issue", "title", request, body).await
    }

    /// The chat's session moving issues to another status, or assigning them (its `move_issues`, `askMove`): `{move:
    /// {ids, status?, assignee?}, project?, why?}`, a status's id or a kind, and an assignee's name, `owner`, or null for
    /// nobody, on the project it names or else the chat's own. Never a proposal waiting on the owner. When the owner's
    /// last message here names each issue that would change, or was sent from its page, they move at once as the
    /// owner's (`moveNow`, ORR-1042): their word is the Allow, and only their own route writes that message, with the
    /// page it was sent from. Otherwise it's kept as a request in the chat showing each issue's from → to, which moves
    /// nothing until they allow it, and one asked before for any of the same issues, still unanswered, expires.
    pub async fn ask_move(&mut self, chat: &str, body: &Value) -> Result<Moved> {
        let own = self.running(chat).await?;
        let project = self.project_for(&own, body).await?;
        let asked = body.get("move").filter(|m| m.is_object()).cloned().unwrap_or(Value::Null);
        let ids =
            asked.get("ids").and_then(Value::as_array).filter(|ids| !ids.is_empty() && ids.iter().all(|i| i.as_str().is_some_and(|i| !i.trim().is_empty())));
        let (status, assignee) = (asked.get("status"), asked.get("assignee"));
        let Some(ids) = ids.filter(|_| status.is_some() || assignee.is_some()) else {
            return Err(ApiError::bad_request(
                "Send {move: {ids, status?, assignee?}}: the issues, and the status to move them to, who to assign them to (null for nobody), or both",
            ));
        };
        if ids.len() > MOVE_AT_MOST {
            return Err(ApiError::bad_request(format!("Ask to move at most {MOVE_AT_MOST} issues at once")));
        }
        let mut to = serde_json::Map::new();
        match status {
            None => {}
            Some(Value::String(s)) => {
                to.insert("status".into(), json!(resolve_status(&Issues::new(&mut *self.conn).statuses(&project).await?, Some(s), None)?));
            }
            Some(_) => return Err(ApiError::bad_request("Send \"status\" as a status's id or a kind")),
        }
        match assignee {
            None => {}
            Some(Value::Null) => {
                to.insert("assignee".into(), Value::Null);
            }
            Some(Value::String(name)) => {
                let name = name.trim();
                let who = if name.is_empty() {
                    Value::Null
                } else if name.eq_ignore_ascii_case("owner") {
                    json!(IssueWrites::new(&mut *self.conn).owner_id().await?)
                } else {
                    json!(name)
                };
                to.insert("assignee".into(), who);
            }
            Some(_) => return Err(ApiError::bad_request("Send \"assignee\" as a name, \"owner\", or null for nobody")),
        }
        let mut sent: Vec<&str> = vec![];
        for id in ids.iter().filter_map(Value::as_str).map(str::trim) {
            if !sent.contains(&id) {
                sent.push(id);
            }
        }
        let mut issues = vec![];
        for id in sent {
            issues.push(Issues::new(&mut *self.conn).issue(&project, id).await?);
        }
        let waiting: Vec<String> = issues.iter().filter(|i| matches!(i["proposal"].as_str(), Some("pending" | "changes"))).map(|i| text_of(&i["id"])).collect();
        if !waiting.is_empty() {
            let (one, its) = if waiting.len() == 1 { ("is a proposal", "its") } else { ("are proposals", "their") };
            return Err(ApiError::refused_for(
                "issues.edit",
                format!("{} {one} waiting on the owner: {its} status and assignee are theirs to decide, on {its} page", waiting.join(", ")),
            ));
        }
        let mut changes = vec![];
        for i in &issues {
            let (id, title, column) = (text_of(&i["id"]), text_of(&i["title"]), text_of(&i["column"]));
            if let Some(to) = to.get("status").filter(|to| to.as_str() != Some(column.as_str())) {
                changes.push(json!({"issue": id, "title": title, "field": "status", "from": column, "to": to}));
            }
            let held = i.get("assignee").cloned().unwrap_or(Value::Null);
            if let Some(to) = to.get("assignee").filter(|to| **to != held) {
                changes.push(json!({"issue": id, "title": title, "field": "assignee", "from": held, "to": to}));
            }
        }
        if changes.is_empty() {
            let named = if issues.len() == 1 { format!("{} is", text_of(&issues[0]["id"])) } else { "They are".into() };
            return Err(ApiError::conflict(format!("{named} like that already: nothing would change")));
        }
        let mut moving: Vec<String> = vec![];
        for change in &changes {
            let id = text_of(&change["issue"]);
            if !moving.contains(&id) {
                moving.push(id);
            }
        }
        // The owner named each in their last message here, or is on its page: moved at once, as theirs.
        let messages = self.messages(Some(chat)).await?.remove(chat).unwrap_or_default();
        let named = messages.iter().rev().find(|m| m["from"] == "owner").is_some_and(|said| {
            let (words, page) = (said["text"].as_str().unwrap_or_default(), said["page"].as_str());
            issues.iter().filter(|i| moving.contains(&text_of(&i["id"]))).all(|i| {
                let mut ids = vec![text_of(&i["id"])];
                ids.extend(i["aliases"].as_array().into_iter().flatten().map(text_of));
                said_issue(words, page, &ids)
            })
        });
        if named {
            return self.move_now(chat, &project, &moving, to).await;
        }
        let asking: Vec<String> = issues.iter().map(|i| text_of(&i["id"])).collect();
        let was: serde_json::Map<String, Value> = issues
            .iter()
            .filter(|i| moving.contains(&text_of(&i["id"])))
            .map(|i| (text_of(&i["id"]), json!({"status": i["column"], "assignee": i.get("assignee").cloned().unwrap_or(Value::Null)})))
            .collect();
        let mut asked_body = serde_json::Map::new();
        asked_body.insert("ids".into(), json!(moving));
        asked_body.extend(to.clone());
        let mut request = json!({"changes": changes, "was": was, "body": asked_body, "state": "asked"});
        if project != own {
            request["project"] = json!(project);
        }
        let why = body.get("why").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
        changes::begin(self.conn).await?;
        let done = async {
            self.expire_moves(chat, &asking).await?;
            let mut said = json!({"from": "claude", "text": why, "images": []});
            said["move"] = request;
            let Value::Object(message) = said else { unreachable!("a JSON object") };
            self.add_in(chat, message).await
        }
        .await;
        self.effects.chats.push(chat.to_string());
        let message = changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let mut details = serde_json::Map::new();
        details.insert("issues".into(), json!(moving));
        details.extend(to.clone());
        let line = format!("The chat asked to put {} {}", moving.join(", "), move_to(&to));
        let set_off = self.note("chat.asked", &project, &line, details).await;
        Ok(Moved { message, project, set_off, urgent: vec![] })
    }

    /// Issues the owner named in their last message moved or assigned at once, as theirs through their chat, as their
    /// own move on the page would be (`moveNow`): the same guards hold, each issue its own write. Any request still
    /// asking to move one expires, as it's been decided. One that fails stops the rest; those moved before it stay
    /// moved, and the error says so.
    async fn move_now(&mut self, chat: &str, project: &str, ids: &[String], to: serde_json::Map<String, Value>) -> Result<Moved> {
        let owner = Actor { name: IssueWrites::new(&mut *self.conn).owner_id().await?, owner: true, ..Actor::default() };
        let mut set_off = Effects::default();
        let mut urgent = vec![];
        let mut moved: Vec<String> = vec![];
        let mut failed = None;
        for issue in ids {
            let mut writes = IssueWrites::new(&mut *self.conn);
            writes.outbox = self.outbox.as_ref().map(|_| Outbox::new(owner.clone()));
            let edited = writes.edit_words(project, issue, &Value::Object(to.clone()), &owner).await;
            absorb(&mut set_off, std::mem::take(&mut writes.effects));
            match edited {
                Ok(made_urgent) => {
                    urgent.extend(made_urgent);
                    moved.push(issue.clone());
                }
                Err(mut error) => {
                    if !moved.is_empty() {
                        error.message = format!("{} ({} moved already)", error.message, moved.join(", "));
                    }
                    failed = Some(error);
                    break;
                }
            }
        }
        if moved.is_empty() {
            return Err(failed.unwrap_or_else(|| ApiError::internal("an issue to move")));
        }
        let place = move_to(&to);
        let mut details = serde_json::Map::new();
        details.insert("issues".into(), json!(moved));
        details.extend(to);
        let line = format!("The chat put {} {place}, as the owner asked", moved.join(", "));
        absorb(&mut set_off, self.note("chat.moved", project, &line, details).await);
        let links = moved.iter().map(|i| format!("[{i}](/p/{project}/issues/{i})")).collect::<Vec<_>>().join(", ");
        let words = format!("Put {links} {place}.");
        let whole = failed.is_none();
        changes::begin(self.conn).await?;
        let done = async {
            self.expire_moves(chat, &moved).await?;
            if !whole {
                return Ok(Value::Null);
            }
            let said = json!({"from": "claude", "text": words, "images": []});
            let Value::Object(message) = said else { unreachable!("a JSON object") };
            self.add_in(chat, message).await
        }
        .await;
        self.effects.chats.push(chat.to_string());
        let message = changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        match failed {
            Some(error) => Err(error),
            None => Ok(Moved { message, project: project.to_string(), set_off, urgent }),
        }
    }

    /// Expires each move request in the chat still asking to move one of `ids`.
    async fn expire_moves(&mut self, chat: &str, ids: &[String]) -> Result<()> {
        for mut asked in self.messages(Some(chat)).await?.remove(chat).unwrap_or_default() {
            let asking = asked["move"]["body"]["ids"].as_array().is_some_and(|on| on.iter().any(|i| ids.iter().any(|id| i == id)));
            if asked["move"]["state"] != "asked" || !asking {
                continue;
            }
            asked["move"]["state"] = json!("expired");
            let at = asked["id"].as_i64().unwrap_or_default();
            let Value::Object(mut message) = asked else { continue };
            message.shift_remove("id");
            message.shift_remove("at");
            self.change_in(chat, at, message).await?;
        }
        Ok(())
    }

    /// A line in the event log, as the local app's `useEventLog().note` writes one, and what it set off. One that can't
    /// be written isn't the request's failure: what it notes has happened.
    async fn note(&mut self, kind: &str, project: &str, message: &str, details: serde_json::Map<String, Value>) -> Effects {
        let mut log = EventLog::new(&mut *self.conn);
        log.outbox = self.outbox.as_ref().map(|_| Outbox::new(Actor::default()));
        let line = json!({"level": "info", "kind": kind, "project": project, "message": message, "details": details});
        match log.write(&line).await {
            Ok(_) => log.effects(),
            Err(_) => Effects::default(),
        }
    }

    /// The project of chat `chat`, a 404 unless it's running.
    async fn running(&mut self, chat: &str) -> Result<String> {
        let own: Option<String> =
            sqlx::query_scalar(&sql("SELECT project FROM chats WHERE id = ? AND ended_at IS NULL")).bind(chat).fetch_optional(&mut *self.conn).await?;
        own.ok_or_else(|| ApiError::not_found(format!("No chat {chat}: it has ended")))
    }

    /// The project a chat's request is on (`projectFor`): the one `body` names, so a chat can ask on another project
    /// than its own (ORR-1063), or else the chat's own, `own`.
    async fn project_for(&mut self, own: &str, body: &Value) -> Result<String> {
        match body.get("project") {
            None | Some(Value::Null) => Ok(own.to_string()),
            Some(Value::String(p)) if p.trim() == own => Ok(own.to_string()),
            Some(Value::String(p)) if !p.trim().is_empty() => {
                crate::board::issue_writes::IssueWrites::new(&mut *self.conn).project_uid(p.trim()).await?;
                Ok(p.trim().to_string())
            }
            Some(_) => Err(ApiError::bad_request("Send \"project\" as a project's id, or leave it out for the chat's own")),
        }
    }

    /// The chat's session asking to make a doc, or change doc `id` (its `create_doc` and `update_doc`, `askDoc`): `{doc,
    /// id?, project?, why?}`, `doc` its title, section and text, on the project it names or else the chat's own. Kept as
    /// a request in the chat holding only what would change and the doc as it was, which saves nothing until the owner
    /// allows it, and which the local app hears (ORR-1100). One it asked before for the same doc, still unanswered,
    /// expires. A 404 when the chat isn't running.
    pub async fn ask_doc(&mut self, chat: &str, body: &Value) -> Result<Value> {
        let own = self.running(chat).await?;
        let project = self.project_for(&own, body).await?;
        let mut request = crate::board::docs::Docs::new(&mut *self.conn).chat_request(&project, body.get("doc"), body.get("id")).await?;
        if project != own {
            request["project"] = json!(project);
        }
        self.ask(chat, "doc", "id", request, body).await
    }

    /// Keeps `request` in the chat as its `kind` (`schedule`, `release`, `doc`, `issue`), with `body`'s `why` for its words, and expires
    /// one of that kind asked before with the same `key`, still unanswered.
    async fn ask(&mut self, chat: &str, kind: &str, key: &str, request: Value, body: &Value) -> Result<Value> {
        let why = body.get("why").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
        changes::begin(self.conn).await?;
        let done = self.ask_in(chat, kind, key, request, why).await;
        self.effects.chats.push(chat.to_string());
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    async fn ask_in(&mut self, chat: &str, kind: &str, key: &str, request: Value, why: String) -> Result<Value> {
        if let Some(named) = request.get(key).filter(|i| !i.is_null()) {
            for mut asked in self.messages(Some(chat)).await?.remove(chat).unwrap_or_default() {
                if asked[kind]["state"] != "asked" || asked[kind][key] != *named {
                    continue;
                }
                asked[kind]["state"] = json!("expired");
                let at = asked["id"].as_i64().unwrap_or_default();
                let Value::Object(mut message) = asked else { continue };
                message.shift_remove("id");
                message.shift_remove("at");
                self.change_in(chat, at, message).await?;
            }
        }
        let mut asked = json!({"from": "claude", "text": why, "images": []});
        asked[kind] = request;
        let Value::Object(message) = asked else { unreachable!("a JSON object") };
        self.add_in(chat, message).await
    }

    /// A 404 unless the chat is kept.
    async fn known(&mut self, chat: &str) -> Result<()> {
        let kept: Option<String> = sqlx::query_scalar(&sql("SELECT id FROM chats WHERE id = ?")).bind(chat).fetch_optional(&mut *self.conn).await?;
        kept.map(|_| ()).ok_or_else(|| ApiError::not_found(format!("No chat {chat}")))
    }

    /// Every chat's messages, oldest first, by chat.
    async fn messages(&mut self, chat: Option<&str>) -> Result<std::collections::HashMap<String, Vec<Value>>> {
        let rows = match chat {
            Some(chat) => {
                sqlx::query(&sql("SELECT chat, CAST(id AS BIGINT) AS id, at, message FROM chat_messages WHERE chat = ? ORDER BY id"))
                    .bind(chat)
                    .fetch_all(&mut *self.conn)
                    .await?
            }
            None => sqlx::query("SELECT chat, CAST(id AS BIGINT) AS id, at, message FROM chat_messages ORDER BY id").fetch_all(&mut *self.conn).await?,
        };
        let mut by_chat: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
        for row in &rows {
            by_chat.entry(row.get::<String, _>("chat")).or_default().push(message_of(row)?);
        }
        Ok(by_chat)
    }

    /// The chats kept, running and ended, newest first (`listChats`).
    pub async fn list(&mut self) -> Result<Value> {
        let rows = sqlx::query("SELECT id, project, chat FROM chats").fetch_all(&mut *self.conn).await?;
        let mut messages = self.messages(None).await?;
        let mut chats = rows.iter().map(|row| chat_of(row, messages.remove(&row.get::<String, _>("id")).unwrap_or_default())).collect::<Result<Vec<_>>>()?;
        let started = |c: &Value| c["started_at"].as_str().unwrap_or_default().to_string();
        chats.sort_by_key(|c| std::cmp::Reverse(started(c)));
        Ok(Value::Array(chats))
    }

    /// One chat, running or ended, or a 404 (`readChat`).
    pub async fn get(&mut self, id: &str) -> Result<Value> {
        let row = sqlx::query(&sql("SELECT project, chat FROM chats WHERE id = ?"))
            .bind(id)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No chat {id}")))?;
        let messages = self.messages(Some(id)).await?.remove(id).unwrap_or_default();
        chat_of(&row, messages)
    }
}
