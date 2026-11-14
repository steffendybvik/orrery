// Releases, a project's and across projects: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::access::seen::Seen;
use crate::board::issues::Issues;
use crate::board::plans::Plans;
use crate::board::releases::Releases;
use crate::changes::Outbox;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, came_of};
use crate::{App, Shared};
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
        .route(&format!("{P}/releases/{{release}}/row"), get(release_row))
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

async fn all_releases(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut value = Plans::new(&mut Issues::new(&mut conn)).all_releases().await?;
    Seen::of(&mut conn, &headers).await?.keep(&mut conn, &mut value, "project").await?;
    Ok(Json(value).into_response())
}

/// `GET …/releases/:release/row` → the release's row as it's stored, in the project's source when it takes its
/// releases from another, for the local app's store (`releaseRow`, ORR-1174), which checks a release a focus names.
/// A 400 for a project with no releases and a 404 for a release there isn't, as the store says each.
async fn release_row(State(app): Shared, Path((project, release)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    if !came_of(&headers).server {
        return Err(ApiError::forbidden("Only the local app reads a release's row"));
    }
    let mut conn = app.pool.acquire().await?;
    let mut issues = Issues::new(&mut conn);
    let row = issues.project(&project).await?;
    issues.release_there(&project, &row, &release).await?;
    let source = if row.release_mode == "shared" { row.releases_from.clone().unwrap_or_default() } else { project.clone() };
    let row =
        sqlx::query(&crate::db::sql("SELECT * FROM releases WHERE project = ? AND version = ?")).bind(&source).bind(&release).fetch_one(&mut *conn).await?;
    Ok(Json(crate::db::row_json(&row)).into_response())
}

#[cfg(test)]
#[path = "releases_tests.rs"]
mod tests;
