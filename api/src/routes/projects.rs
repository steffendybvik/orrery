// Projects: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::board::imports::check_roadmap;
use crate::board::issue_writes::IssueWrites;
use crate::board::projects::Projects;
use crate::board::{export, projects};
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of, who_of};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route(P, get(get_project).patch(patch_project).delete(delete_project))
        .route(&format!("{P}/export"), get(export_project))
        .route(&format!("{P}/import"), post(import_project))
}

/// `GET /api/projects` → every project with its counts; `?expand=board` gives each one's board instead, without the
/// events stream's `rev`, which the Nuxt server adds. `&notes=0` and `&closed=0` trim the boards as one project's read
/// does, but for the projects in `&whole=` (comma-separated ids).
async fn list_projects(State(app): Shared, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let boards = query.get("expand").is_some_and(|e| e == "board");
    let mut value = Projects::new(&mut conn).list(boards).await?;
    if boards {
        let dropped = |key: &str| query.get(key).is_some_and(|v| v == "0");
        let whole: Vec<&str> = query.get("whole").map(|w| w.split(',').collect()).unwrap_or_default();
        for project in value.as_array_mut().into_iter().flatten() {
            let kept = project["id"].as_str().is_some_and(|id| whole.contains(&id));
            projects::trim_board(project, !dropped("notes"), kept || !dropped("closed"));
        }
    }
    Ok(Json(value).into_response())
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

/// `DELETE /api/projects/{project}` → 204; everything in it goes too, for good (`deleteProject`).
async fn delete_project(State(app): Shared, Path(project): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut projects = Projects::new(&mut conn);
    projects.outbox = Some(Outbox::new(actor_of(&headers)));
    projects.delete(&project, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut projects.effects)))
}

/// `GET /api/projects/{project}/export` → the board as one file (`board::export`), named for the project and the day, so a
/// browser saves it.
async fn export_project(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let board = export::export(&mut conn, &project).await?;
    let day = board["exported_at"].as_str().unwrap_or_default().get(..10).unwrap_or_default().to_string();
    let mut response = Json(board).into_response();
    let named = format!("attachment; filename=\"{project}-{day}.orrery.json\"");
    if let Ok(value) = HeaderValue::from_str(&named) {
        response.headers_mut().insert(axum::http::header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

/// `POST /api/projects/{project}/import` {milestones: […]} in `docs/roadmap.json`'s format → the project; refused when it
/// has milestones or issues already, unless `?replace=true` (`importRoadmap`).
async fn import_project(
    State(app): Shared,
    Path(project): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    let roadmap = check_roadmap(&body_of(&body))?;
    let mut conn = app.pool.acquire().await?;
    let actor = actor_of(&headers);
    let mut writes = IssueWrites::new(&mut conn);
    writes.outbox = Some(Outbox::new(actor.clone()));
    writes.import_roadmap(&project, &roadmap, query.get("replace").is_some_and(|r| r == "true"), &actor).await?;
    let effects = std::mem::take(&mut writes.effects);
    let value = Projects::new(&mut conn).project(&project).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
