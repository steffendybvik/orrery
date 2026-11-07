// Session presets: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::error::Result;
use crate::presets::{preset_id, Presets};
use crate::reply::reply;
use crate::request::{actor_of, body_of};
use crate::write::Effects;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/presets", get(list_presets).post(create_preset))
        .route("/api/presets/defaults", post(restore_presets))
        .route("/api/presets/{preset}", patch(patch_preset).delete(delete_preset))
        .route("/api/presets/{preset}/reset", post(reset_preset))
        .route(&format!("{P}/presets"), get(list_project_presets).post(create_project_preset))
}

async fn list_presets(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Presets::new(&mut conn).list(None).await?).into_response())
}

async fn list_project_presets(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Presets::new(&mut conn).list(Some(&project)).await?).into_response())
}

async fn create_preset(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let preset = Presets::new(&mut conn).create(None, &body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::CREATED, Some(preset), Effects::default()))
}

async fn create_project_preset(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let preset = Presets::new(&mut conn).create(Some(&project), &body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::CREATED, Some(preset), Effects::default()))
}

/// The preset the URL names, by its number or its full id on this server.
async fn preset_named(presets: &mut Presets<'_>, sent: &str) -> Result<i64> {
    let uid = presets.uid().await?;
    preset_id(sent, &uid)
}

async fn patch_preset(State(app): Shared, Path(preset): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut presets = Presets::new(&mut conn);
    let id = preset_named(&mut presets, &preset).await?;
    Ok(Json(presets.update(id, &body_of(&body), &actor_of(&headers)).await?).into_response())
}

async fn delete_preset(State(app): Shared, Path(preset): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut presets = Presets::new(&mut conn);
    let id = preset_named(&mut presets, &preset).await?;
    presets.delete(id, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, Effects::default()))
}

async fn reset_preset(State(app): Shared, Path(preset): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut presets = Presets::new(&mut conn);
    let id = preset_named(&mut presets, &preset).await?;
    Ok(Json(presets.reset(id, &actor_of(&headers)).await?).into_response())
}

async fn restore_presets(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Presets::new(&mut conn).restore(&actor_of(&headers)).await?).into_response())
}
