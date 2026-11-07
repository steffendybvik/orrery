// Projects: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::changes::Outbox;
use crate::error::Result;
use crate::projects::Projects;
use crate::reply::reply;
use crate::request::{actor_of, body_of, who_of};
use crate::{projects, App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/projects", get(list_projects).post(create_project)).route(P, get(get_project).patch(patch_project))
}

async fn list_projects(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Projects::new(&mut conn).list().await?).into_response())
}

/// `GET /api/projects/{project}` → the project with its board (`project`), without the events stream's `rev`, which the
/// Nuxt server adds; `?notes=0` leaves the issues' notes out (`withoutNotes`), and `?closed=0` the closed issues with no
/// open sub-issue (`withoutClosed`).
async fn get_project(State(app): Shared, Path(project): Path<String>, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut value = Projects::new(&mut conn).project(&project).await?;
    let dropped = |key: &str| query.get(key).is_some_and(|v| v == "0");
    projects::trim_board(&mut value, !dropped("notes"), !dropped("closed"));
    Ok(Json(value).into_response())
}

async fn create_project(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut projects = Projects::new(&mut conn);
    projects.outbox = Some(Outbox::new(actor_of(&headers)));
    let id = projects.create(&body_of(&body), who_of(&headers).as_ref(), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut projects.effects);
    let value = projects.project(&id).await?;
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn patch_project(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut projects = Projects::new(&mut conn);
    projects.outbox = Some(Outbox::new(actor_of(&headers)));
    projects.update(&project, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut projects.effects);
    let value = projects.project(&project).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}
