// Schedules: the handlers and the routes they answer (ORR-1048); of the writes, adopting and deleting one (ORR-950), and
// pausing or activating all of a project's, and changing one (ORR-1082).
use super::P;
use crate::changes::Outbox;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of};
use crate::work::presets::Presets;
use crate::work::schedules::Schedules;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(&format!("{P}/schedules"), get(list_schedules))
        .route(&format!("{P}/schedules/{{schedule}}"), get(get_schedule).patch(patch_schedule).delete(delete_schedule))
        .route(&format!("{P}/schedules/{{schedule}}/adopt"), post(adopt_schedule))
        .route(&format!("{P}/schedules/enabled"), post(set_all_enabled))
        .route("/api/schedules", get(all_schedules))
        .route("/api/schedules/across", get(schedules_across))
}

async fn all_schedules(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Schedules::new(&mut conn).list(None).await?).into_response())
}

async fn list_schedules(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Schedules::new(&mut conn).list(Some(&project)).await?).into_response())
}

async fn get_schedule(State(app): Shared, Path((project, schedule)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    Ok(Json(Schedules::new(&mut conn).get(&project, &schedule, &uid).await?).into_response())
}

/// `POST …/schedules/:schedule/adopt` {seen?}: the owner making an agent's schedule theirs (ORR-456).
async fn adopt_schedule(State(app): Shared, Path((project, schedule)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    // No body, or one that isn't JSON, is none, as `readBody(…).catch(() => undefined)` takes it.
    let body = body_of(&body);
    let seen = match body.get("seen") {
        None | Some(Value::Null) => None,
        Some(Value::String(seen)) => Some(seen.clone()),
        Some(_) => return Err(ApiError::bad_request("\"seen\" is the updated_at you read the schedule at")),
    };
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let adopted = schedules.adopt(&project, &schedule, &uid, &actor, seen.as_deref()).await?;
    Ok(reply(StatusCode::OK, Some(adopted), std::mem::take(&mut schedules.effects)))
}

/// `POST …/schedules/enabled` {enabled} → {changed, failed}: the owner pausing or activating all of the project's
/// schedules. A paused one-off isn't activated, as it may have run, and one that fails doesn't stop the rest.
async fn set_all_enabled(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let Some(enabled) = body_of(&body).get("enabled").and_then(Value::as_bool) else {
        return Err(ApiError::bad_request("Send {\"enabled\": true} or {\"enabled\": false}"));
    };
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let done = schedules.set_all_enabled(&project, enabled, &uid, &actor).await?;
    Ok(reply(StatusCode::OK, Some(done), std::mem::take(&mut schedules.effects)))
}

/// `PATCH …/schedules/:schedule` {any of its fields} → the schedule: `enabled: false` pauses it.
async fn patch_schedule(State(app): Shared, Path((project, schedule)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let changed = schedules.update(&project, &schedule, &body_of(&body), &uid, &actor).await?;
    Ok(reply(StatusCode::OK, Some(changed), std::mem::take(&mut schedules.effects)))
}

/// `DELETE …/schedules/:schedule`: the issues it made stay.
async fn delete_schedule(State(app): Shared, Path((project, schedule)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    schedules.delete(&project, &schedule, &uid, &actor).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut schedules.effects)))
}

async fn schedules_across(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Schedules::new(&mut conn).across().await?).into_response())
}

#[cfg(test)]
#[path = "schedules_tests.rs"]
mod tests;
