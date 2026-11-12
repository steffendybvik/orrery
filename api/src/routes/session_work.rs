// Which session is on which issue (ORR-1141): the reads the Nuxt server's session bookkeeping makes, so it needn't open
// the database (ORR-1093). They're the local app's own calls alone (`Orrery-Came: server`), as only it knows which
// sessions are there to hear.
use super::P;
use crate::error::{ApiError, Result};
use crate::request::came_of;
use crate::work::session_work::SessionWork;
use crate::{App, Shared};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(&format!("{P}/issue-sessions"), get(working))
        .route(&format!("{P}/issues/{{issue}}/workers"), get(workers))
        .route(&format!("{P}/issues/{{issue}}/dependents"), get(dependents))
}

fn local_app_only(headers: &HeaderMap) -> Result<()> {
    if came_of(headers).server {
        Ok(())
    } else {
        Err(ApiError::forbidden("Only the local app asks which session is on which issue"))
    }
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

#[cfg(test)]
#[path = "session_work_tests.rs"]
mod tests;
