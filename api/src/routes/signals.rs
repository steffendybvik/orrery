// A project's signals: the handlers and the routes they answer (ORR-1087, ORR-1090). Reading them is anyone's; writing
// them is the local app's own call alone (`Orrery-Came: server`), as it picks which session each goes to, tells it,
// and runs the stream and the listeners.
use super::P;
use crate::error::{ApiError, Result};
use crate::request::{body_of, came_of};
use crate::work::signals::{Signals, Which, LIMIT};
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
        .route(&format!("{P}/signals"), get(list_signals).post(write_signal))
        .route(&format!("{P}/signals/retarget"), post(retarget))
        .route(&format!("{P}/signals/{{signal}}/receipts"), post(receipt))
        .route("/api/signals/prune", post(prune))
}

/// Only the local app's own call: it picked the session, and tells it itself.
fn local_app_only(headers: &HeaderMap) -> Result<()> {
    if came_of(headers).server {
        Ok(())
    } else {
        Err(ApiError::forbidden("Only the local app writes a signal; a page or a session asks for one with a focus, a comment or a message"))
    }
}

/// A text field of the body, or a 400 that names it.
fn text_of<'a>(body: &'a Value, key: &str) -> Result<&'a str> {
    body.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).ok_or_else(|| ApiError::bad_request(format!("Send \"{key}\"")))
}

/// The signal, written, as `signalOf` gives it.
async fn write_signal(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let signal = Signals::new(&mut conn).write(&project, &body_of(&body)).await?;
    Ok((StatusCode::CREATED, Json(signal)).into_response())
}

/// `{to}`, the session's name: the signal, with it among those that heard it.
async fn receipt(State(app): Shared, Path((project, signal)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    local_app_only(&headers)?;
    let id: i64 = signal.parse().map_err(|_| ApiError::not_found(format!("No signal {signal} in {project}")))?;
    let body = body_of(&body);
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Signals::new(&mut conn).receipt(&project, id, text_of(&body, "to")?).await?).into_response())
}

/// `{from, to}`, a session's old id and its new one: `{moved}`, how many signals went to the new one.
async fn retarget(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    local_app_only(&headers)?;
    let body = body_of(&body);
    let mut conn = app.pool.acquire().await?;
    let moved = Signals::new(&mut conn).retarget(&project, text_of(&body, "from")?, text_of(&body, "to")?).await?;
    Ok(Json(json!({"moved": moved})).into_response())
}

/// `{pruned}`: how many old signals went, as the local app asks with its daily clean-up.
async fn prune(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(json!({"pruned": Signals::new(&mut conn).prune().await?})).into_response())
}

/// `?after=` the signals after that id, oldest first (anything not a number is 0, as `Number(…) || 0` reads it);
/// `?issue=` or `?milestone=` the latest about that issue or milestone instead; `?waiting=pooled` or `scheduled` those
/// from the last day no session has heard yet, for the one orrery picks or scheduled (ORR-1141); `?waiting=focus&issue=`
/// the owner's or a member's focus on that issue from the last ten minutes not heard yet (ORR-1131).
async fn list_signals(State(app): Shared, Path(project): Path<String>, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let text = |key: &str| query.get(key).map(String::as_str).filter(|v| !v.is_empty());
    let which = match (text("waiting"), text("issue"), text("milestone")) {
        (Some("pooled"), _, _) => Which::Pooled,
        (Some("scheduled"), _, _) => Which::Scheduled,
        (Some("focus"), Some(issue), _) => Which::Focus(issue),
        (Some("focus"), None, _) => return Err(ApiError::bad_request("\"waiting\": \"focus\" needs an \"issue\"")),
        (Some(other), _, _) => return Err(ApiError::bad_request(format!("\"waiting\" is \"{other}\"; use pooled, scheduled, focus"))),
        (None, Some(issue), _) => Which::Issue(issue),
        (None, None, Some(milestone)) => Which::Milestone(milestone),
        (None, None, None) => Which::After(after_of(query.get("after").map(String::as_str))),
    };
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Signals::new(&mut conn).list(&project, which, LIMIT).await?).into_response())
}

/// `Number(after ?? 0) || 0`, for what a query string can hold: blank is 0, and so is anything not a number.
pub(crate) fn after_of(sent: Option<&str>) -> f64 {
    let trimmed = sent.unwrap_or("").trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed.parse::<f64>() {
        Ok(n) if n.is_finite() => n,
        // Rust reads `inf` and `nan` too, where JavaScript reads only `Infinity`.
        Ok(n) if trimmed.trim_start_matches(['+', '-']) == "Infinity" => n,
        _ => 0.0,
    }
}

#[cfg(test)]
#[path = "signals_tests.rs"]
mod tests;
