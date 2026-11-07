// The bell: the handlers and the routes they answer (ORR-1048).
use crate::error::{ApiError, Result};
use crate::notices::{Asked, Notices};
use crate::{actor_of, body_of, owner_asking, who_of, App, Shared};
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/notices", get(list_notices))
        .route("/api/notices/changes", get(notice_changes))
        .route("/api/notices/clear", post(clear_notices))
        .route("/api/notices/read", post(read_notices))
}

/// The bell's reads (ORR-1005): whose it is, as `personOf` has it.
async fn list_notices(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut notices = Notices::new(&mut conn);
    let person = notices.person_of(who_of(&headers).as_ref(), &actor_of(&headers)).await?;
    Ok(Json(notices.notices(&Asked::of(&query), person.as_deref()).await?).into_response())
}

async fn notice_changes(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut notices = Notices::new(&mut conn);
    let person = notices.person_of(who_of(&headers).as_ref(), &actor_of(&headers)).await?;
    Ok(Json(notices.changes(query.get("since").map(String::as_str), person.as_deref()).await?).into_response())
}

/// Who clears the bell or marks it read (`notices.clear`): a member their own, else only the owner, as the routes'
/// `memberAsking` and `authorize` have it.
fn bell_keeper(headers: &HeaderMap) -> Result<Option<String>> {
    let actor = actor_of(headers);
    if let Some(person) = actor.person {
        return Ok(Some(person));
    }
    if owner_asking(headers) {
        return Ok(None);
    }
    let what = "Clear the bell or mark it read, or forget a session";
    let why = "What waits on the owner goes when they say.";
    let message = if actor.untrusted {
        format!("{what}: refused for an untrusted session (notices.clear). {why}")
    } else if actor.chat {
        format!("{what}: refused for the owner's chat (notices.clear). {why}")
    } else {
        format!("{what}: owner only for a session (notices.clear). {why} Send Orrery-Actor: <owner>")
    };
    Err(ApiError::refused_for("notices.clear", message))
}

async fn clear_notices(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let person = bell_keeper(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let cleared = Notices::new(&mut conn).clear(&body_of(&body), person.as_deref()).await?;
    Ok(Json(json!({"cleared": cleared})).into_response())
}

async fn read_notices(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let person = bell_keeper(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let read = Notices::new(&mut conn).read(&body_of(&body), person.as_deref()).await?;
    Ok(Json(json!({"read": read})).into_response())
}
