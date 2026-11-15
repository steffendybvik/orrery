// A session's record (ORR-1171): whether it's an untrusted schedule's session or the owner's chat, and the project an
// untrusted one was started for. The Nuxt server writes it once (`PUT /api/session-records/:session`, from
// `recordSession` in utils/api-router.ts), and a later write can only tighten it: an untrusted session never becomes
// the chat or moves to another project. The rails read it by the session a request names (`Orrery-Session`, and
// `Orrery-Worked-By`, the id it goes by after a `/clear`), so what the router says on a request can only add to it.
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::request::header;
use crate::write::{stamp, Actor};
use axum::http::HeaderMap;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use sqlx::{AnyConnection, Row};

/// The kinds a record holds, loosest first: an untrusted session is held tighter than the chat.
const KINDS: [&str; 2] = ["chat", "untrusted"];

/// A session as it's recorded.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct SessionRecord {
    pub session: String,
    pub kind: String,
    pub project: Option<String>,
    pub workspace: String,
    pub at: String,
}

pub(crate) struct SessionRecords<'a> {
    conn: &'a mut AnyConnection,
}

impl<'a> SessionRecords<'a> {
    pub(crate) fn new(conn: &'a mut AnyConnection) -> Self {
        Self { conn }
    }

    /// The record of the first of these ids that has one.
    pub(crate) async fn of(&mut self, ids: &[String]) -> Result<Option<SessionRecord>> {
        for id in ids {
            let row = sqlx::query(&sql("SELECT session, kind, project, workspace, at FROM session_records WHERE session = ?"))
                .bind(id)
                .fetch_optional(&mut *self.conn)
                .await?;
            if let Some(row) = row {
                return Ok(Some(SessionRecord {
                    session: row.get("session"),
                    kind: row.get("kind"),
                    project: row.get("project"),
                    workspace: row.get("workspace"),
                    at: row.get("at"),
                }));
            }
        }
        Ok(None)
    }

    /// Keeps the session as `kind` (`untrusted` or `chat`), held to `project` if it's untrusted, and gives back the
    /// record as it now stands. A write that would loosen it (the chat after untrusted, another project) is refused; one
    /// that says less than what's kept (no project) leaves it be.
    pub(crate) async fn keep(&mut self, session: &str, kind: &str, project: Option<&str>) -> Result<SessionRecord> {
        let Some(rank) = KINDS.iter().position(|k| *k == kind) else {
            return Err(ApiError::bad_request(format!("A session's kind is {}, not \"{kind}\"", KINDS.join(" or "))));
        };
        let project = project.filter(|p| !p.is_empty()).filter(|_| kind == "untrusted");
        let ids = [session.to_string()];
        let Some(kept) = self.of(&ids).await? else {
            let workspace = match project {
                Some(project) => sqlx::query(&sql("SELECT workspace FROM projects WHERE id = ?"))
                    .bind(project)
                    .fetch_optional(&mut *self.conn)
                    .await?
                    .map(|r| r.get::<String, _>("workspace")),
                None => None,
            }
            .unwrap_or_else(|| "default".into());
            sqlx::query(&sql("INSERT INTO session_records (session, kind, project, workspace, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session) DO NOTHING"))
                .bind(session)
                .bind(kind)
                .bind(project)
                .bind(&workspace)
                .bind(stamp())
                .execute(&mut *self.conn)
                .await?;
            // Another write may have got there first: what's kept is what holds.
            return Box::pin(self.keep(session, kind, project)).await;
        };
        let kept_rank = KINDS.iter().position(|k| *k == kept.kind).unwrap_or(KINDS.len());
        if rank < kept_rank {
            return Err(ApiError::conflict(format!("Session {session} is kept as {}, which it stays", kept.kind)));
        }
        if let (Some(held), Some(asked)) = (kept.project.as_deref(), project) {
            if held != asked {
                return Err(ApiError::conflict(format!("Session {session} is held to {held}, which it stays")));
            }
        }
        let tighter_kind = rank > kept_rank;
        let tighter_project = kept.project.is_none() && project.is_some();
        if !tighter_kind && !tighter_project {
            return Ok(kept);
        }
        sqlx::query(&sql("UPDATE session_records SET kind = ?, project = ? WHERE session = ?"))
            .bind(kind)
            .bind(project.or(kept.project.as_deref()).filter(|_| kind == "untrusted"))
            .bind(session)
            .execute(&mut *self.conn)
            .await?;
        Ok(self.of(&ids).await?.expect("just kept"))
    }

    /// The session's new id (after a `/clear`) is recorded as its old one was; the old id keeps its record too, as a
    /// request may still name it.
    pub(crate) async fn carry(&mut self, from: &str, to: &str) -> Result<()> {
        sqlx::query(&sql(
            "INSERT INTO session_records (session, kind, project, workspace, at) SELECT ?, kind, project, workspace, at FROM session_records WHERE session = ? ON CONFLICT (session) DO NOTHING",
        ))
        .bind(to)
        .bind(from)
        .execute(&mut *self.conn)
        .await?;
        Ok(())
    }
}

/// The ids a request names its session by: the one it sent (`Orrery-Session`) and the one the router says it goes by
/// now (`Orrery-Worked-By`), decoded.
fn named_ids(headers: &HeaderMap) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for name in ["orrery-session", "orrery-worked-by"] {
        if let Some(id) = header(headers, name).map(|v| percent_decode_str(v.trim()).decode_utf8_lossy().into_owned()).filter(|v| !v.is_empty()) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// Who's asking as the session's record holds them: untrusted when the router or the record says so, and the chat when
/// either says so and it isn't untrusted. With the project an untrusted session was started for, which only the
/// record says (nothing for one that isn't recorded yet, or was recorded without one).
pub(crate) async fn as_recorded(conn: &mut AnyConnection, headers: &HeaderMap, actor: &Actor) -> Result<(Actor, Option<String>)> {
    let mut held = actor.clone();
    let ids = named_ids(headers);
    if ids.is_empty() {
        return Ok((held, None));
    }
    let Some(record) = SessionRecords::new(conn).of(&ids).await? else {
        return Ok((held, None));
    };
    match record.kind.as_str() {
        "untrusted" => {
            held.untrusted = true;
            held.chat = false;
        }
        "chat" if !held.untrusted => held.chat = true,
        _ => {}
    }
    let own = record.project.filter(|_| held.untrusted && record.kind == "untrusted");
    Ok((held, own))
}

#[cfg(test)]
#[path = "session_records_tests.rs"]
mod tests;
