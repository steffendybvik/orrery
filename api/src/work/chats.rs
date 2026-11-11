// The owner's chats, reading them as they're kept (ORR-951): the `chats` table, as `chatsLoaded` reads it back into
// web/server/utils/chats.ts, and `listChats` and `readChat` answer from it. Written ahead: the Nuxt server answers from
// its memory, which is ahead of the table, as a chat's change is saved just after it, and why a launcher couldn't start
// one (`problem`) is never kept. Running a chat stays the local app's, as its session is; what it keeps of one is its
// row, written here too (`keepChat`), for the local app to hand over once it's swapped in. A chat's messages are rows
// of their own (`chat_messages`, ORR-1100), each added here, which gives it its id, and changed one at a time (a
// request's answer, its drift), so the chat's requests can be asked and answered here too.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::Effects;
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
