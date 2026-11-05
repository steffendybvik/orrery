// The owner's chats, reading them as they're kept (ORR-951): the `chats` table, as `chatsLoaded` reads it back into
// web/server/utils/chats.ts, and `listChats` and `readChat` answer from it. Written ahead: the Nuxt server answers from
// its memory, which is ahead of the table, as a chat's change is saved just after it, and why a launcher couldn't start
// one (`problem`) is never kept. Running a chat, and every write to one, stays the local app's: its session is.
use crate::db::sql;
use crate::error::{ApiError, Result};
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
}

impl<'c> Chats<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Chats { conn }
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
