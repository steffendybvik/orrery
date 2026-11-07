// Releases, a project's and across projects: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::changes::Outbox;
use crate::error::Result;
use crate::issues::Issues;
use crate::plans::Plans;
use crate::releases::Releases;
use crate::{actor_of, body_of, reply, App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(&format!("{P}/releases"), get(list_releases).post(create_release))
        .route(&format!("{P}/releases/{{release}}"), get(get_release).patch(patch_release).delete(delete_release))
        .route("/api/releases", get(all_releases))
}

async fn create_release(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut releases = Releases::new(&mut conn);
    releases.outbox = Some(Outbox::new(actor_of(&headers)));
    let version = releases.create(&project, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut releases.effects);
    let value = Plans::new(&mut Issues::new(&mut conn)).release(&project, &version).await?;
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn patch_release(State(app): Shared, Path((project, release)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut releases = Releases::new(&mut conn);
    releases.outbox = Some(Outbox::new(actor_of(&headers)));
    releases.update(&project, &release, &body_of(&body)).await?;
    let effects = std::mem::take(&mut releases.effects);
    let value = Plans::new(&mut Issues::new(&mut conn)).release(&project, &release).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn delete_release(State(app): Shared, Path((project, release)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut releases = Releases::new(&mut conn);
    releases.outbox = Some(Outbox::new(actor_of(&headers)));
    releases.delete(&project, &release, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut releases.effects)))
}

async fn list_releases(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).releases(&project).await?).into_response())
}

async fn get_release(State(app): Shared, Path((project, release)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).release(&project, &release).await?).into_response())
}

async fn all_releases(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).all_releases().await?).into_response())
}
