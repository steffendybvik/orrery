// Which session is on which issue (ORR-1141): the reads the Nuxt server's session bookkeeping makes, so it needn't open
// the database (ORR-1093). They're the local app's own calls alone (`Orrery-Came: server`), as only it knows which
// sessions are there to hear.
use super::P;
use crate::error::{ApiError, Result};
use crate::request::{body_of, came_of};
use crate::work::session_work::{Asked, SessionWork};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(&format!("{P}/issue-sessions"), get(working))
        .route(&format!("{P}/session-work"), get(session_work))
        .route(&format!("{P}/issue-sessions/rename"), post(rename))
        .route(&format!("{P}/issues/{{issue}}/workers"), get(workers))
        .route(&format!("{P}/issues/{{issue}}/dependents"), get(dependents))
        .route(&format!("{P}/issues/{{issue}}/worked-by"), post(worked_by))
}

fn local_app_only(headers: &HeaderMap) -> Result<()> {
    if came_of(headers).server {
        Ok(())
    } else {
        Err(ApiError::forbidden("Only the local app asks which session is on which issue"))
    }
}

/// `?sessions=[{id, name, ids}]` (JSON): `{<session id>: {issues, signals}}`, what each of the project's sessions is on,
/// for its Sessions page (ORR-1174). Which sessions are there is the local app's to say, as only it knows them.
async fn session_work(State(app): Shared, Path(project): Path<String>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap) -> Result<Response> {
    local_app_only(&headers)?;
    let sessions: Vec<Asked> = match query.get("sessions").filter(|s| !s.is_empty()) {
        Some(text) => serde_json::from_str(text).map_err(|_| ApiError::bad_request("Send \"sessions\" as a JSON list of {id, name, ids}"))?,
        None => Vec::new(),
    };
    let mut conn = app.pool.acquire().await?;
    Ok(Json(SessionWork::new(&mut conn).work(&project, &sessions, 5).await?).into_response())
}

/// `?sessions=a,b`, a session's ids (its old ones after a `/clear` too): `{issues, waiting, waiting_for}`, the issues in
/// progress it worked last, each with its latest comment, and whether a signal of the owner's waits for it (`waiting`:
/// to it, every session or the one orrery picks; `waiting_for`: to it by name).
async fn working(State(app): Shared, Path(project): Path<String>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap) -> Result<Response> {
    local_app_only(&headers)?;
    let sessions: Vec<String> =
        query.get("sessions").map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default();
    let mut conn = app.pool.acquire().await?;
    let mut work = SessionWork::new(&mut conn);
    let issues = work.working_on(&project, &sessions).await?;
    let (waiting, waiting_for) = work.waiting(&project, &sessions).await?;
    Ok(Json(json!({"issues": issues, "waiting": waiting, "waiting_for": waiting_for})).into_response())
}

/// The issue and each above it, nearest first: `[{issue, started, worker}]`.
async fn workers(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(SessionWork::new(&mut conn).workers(&project, &issue).await?).into_response())
}

/// The issues that depend on this one, in any project: `[{project, id}]`, oldest link first.
async fn dependents(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(SessionWork::new(&mut conn).dependents(&project, &issue).await?).into_response())
}

/// `{session}`: the session is working the issue now. The local app checked first that no other session has it
/// started and there to hear, as only it knows who's listening.
async fn worked_by(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    local_app_only(&headers)?;
    let body = body_of(&body);
    let session = body.get("session").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request("Send \"session\""))?;
    let mut conn = app.pool.acquire().await?;
    SessionWork::new(&mut conn).worked_by(&project, &issue, session).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `{from, to}`, a session's old id and its new one (after a `/clear`): `{moved}`, how many issues it worked went to the
/// new one. Its signals move with `…/signals/retarget`.
async fn rename(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    local_app_only(&headers)?;
    let body = body_of(&body);
    let named = |key: &str| body.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request(format!("Send \"{key}\"")));
    let (from, to) = (named("from")?, named("to")?);
    let mut conn = app.pool.acquire().await?;
    let moved = SessionWork::new(&mut conn).rename(&project, from, to).await?;
    Ok(Json(json!({"moved": moved})).into_response())
}

#[cfg(test)]
#[path = "session_work_tests.rs"]
mod tests;
