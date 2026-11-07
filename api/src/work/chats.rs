// The owner's chats, reading them as they're kept (ORR-951): the `chats` table, as `chatsLoaded` reads it back into
// web/server/utils/chats.ts, and `listChats` and `readChat` answer from it. Written ahead: the Nuxt server answers from
// its memory, which is ahead of the table, as a chat's change is saved just after it, and why a launcher couldn't start
// one (`problem`) is never kept. Running a chat stays the local app's, as its session is; what it keeps of one is its
// row, written here too (`keepChat`), for the local app to hand over once it's swapped in.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::Effects;
use serde_json::{json, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

/// A chat as kept: its JSON, with the row's project (`{...JSON.parse(row.chat), project: row.project}`).
fn chat_of(row: &AnyRow) -> Result<Value> {
    let mut chat: Value = serde_json::from_str(&row.get::<String, _>("chat")).map_err(|_| ApiError::internal("a chat kept as JSON"))?;
    let Some(fields) = chat.as_object_mut() else { return Err(ApiError::internal("a chat kept as an object")) };
    fields.insert("project".into(), json!(row.get::<String, _>("project")));
    Ok(chat)
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
        if !sent.get("messages").is_some_and(Value::is_array) {
            problems.push("\"messages\" should be a list".into());
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

    /// Lets go of the chat's row (`keepChat` with `gone`): one that ended before anything was said, or deleted.
    pub async fn forget(&mut self, id: &str) -> Result<()> {
        changes::begin(self.conn).await?;
        let done = sqlx::query(&sql("DELETE FROM chats WHERE id = ?")).bind(id).execute(&mut *self.conn).await.map(|_| ()).map_err(Into::into);
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// The chats kept, running and ended, newest first (`listChats`).
    pub async fn list(&mut self) -> Result<Value> {
        let rows = sqlx::query("SELECT project, chat FROM chats").fetch_all(&mut *self.conn).await?;
        let mut chats = rows.iter().map(chat_of).collect::<Result<Vec<_>>>()?;
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
        chat_of(&row)
    }
}
