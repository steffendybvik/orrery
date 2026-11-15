// Which sessions are there to hear (ORR-1172): the Nuxt server says so as their channels connect, beat and go
// (access/presence.rs). It's the local app's own call alone (`Orrery-Came: server`), as only it hears the channels.
use crate::access::presence::Presence;
use crate::error::{ApiError, Result};
use crate::request::{body_of, came_of};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use axum::Router;
use serde_json::Value;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/session-presence/{session}", put(keep).delete(forget))
}

fn local_only(headers: &HeaderMap) -> Result<()> {
    if came_of(headers).server {
        Ok(())
    } else {
        Err(ApiError::forbidden("Only the local app says which sessions are there"))
    }
}

/// `{projects}`: the session is there, heard on these projects and no others. 204.
async fn keep(State(app): Shared, Path(session): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    local_only(&headers)?;
    let body = body_of(&body);
    let projects = body
        .get("projects")
        .and_then(Value::as_array)
        .and_then(|all| all.iter().map(|p| p.as_str().filter(|p| !p.is_empty()).map(str::to_string)).collect::<Option<Vec<_>>>())
        .ok_or_else(|| ApiError::bad_request("Send {projects}: the ids of the projects the session is heard on"))?;
    let mut conn = app.pool.acquire().await?;
    Presence::new(&mut conn).keep(&session, &projects).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// The session has gone. 204.
async fn forget(State(app): Shared, Path(session): Path<String>, headers: HeaderMap) -> Result<Response> {
    local_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    Presence::new(&mut conn).forget(&session).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
#[path = "session_presence_tests.rs"]
mod tests;
