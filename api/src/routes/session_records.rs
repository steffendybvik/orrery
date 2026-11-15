// A session's record (ORR-1171): the Nuxt server keeps whether a session is untrusted or the chat, and the project an
// untrusted one was started for, once, so the rails read it themselves (access/session_records.rs). It's the local
// app's own call alone (`Orrery-Came: server`), as only it hears what a session's launch and channel say.
use crate::access::session_records::SessionRecords;
use crate::error::{ApiError, Result};
use crate::request::{body_of, came_of};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use axum::{Json, Router};
use serde_json::Value;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/session-records/{session}", put(keep))
}

/// `{kind, project?}`: the session is `untrusted` (held to `project`) or `chat`. Gives back the record as it stands; a
/// write that would loosen it is a 409.
async fn keep(State(app): Shared, Path(session): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    if !came_of(&headers).server {
        return Err(ApiError::forbidden("Only the local app records what a session is"));
    }
    let body = body_of(&body);
    let kind = body.get("kind").and_then(Value::as_str).ok_or_else(|| ApiError::bad_request("Send \"kind\""))?;
    let project = match body.get("project") {
        None | Some(Value::Null) => None,
        Some(Value::String(project)) => Some(project.as_str()),
        Some(_) => return Err(ApiError::bad_request("\"project\" is a project's id")),
    };
    let mut conn = app.pool.acquire().await?;
    let record = SessionRecords::new(&mut conn).keep(&session, kind, project).await?;
    Ok(Json(record).into_response())
}

#[cfg(test)]
#[path = "session_records_tests.rs"]
mod tests;
