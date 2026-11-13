// Projects: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::board::board_upload::{self, Upload};
use crate::board::imports::check_roadmap;
use crate::board::issue_writes::IssueWrites;
use crate::board::projects::Projects;
use crate::board::{export, projects};
use crate::changes::Outbox;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, came_of, who_of};
use crate::{App, Shared};
use axum::body::{to_bytes, Bytes};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route(P, get(get_project).patch(patch_project).delete(delete_project))
        .route(&format!("{P}/export"), get(export_project))
        .route(&format!("{P}/release-peers"), get(release_peers))
        .route(&format!("{P}/row"), get(project_row))
        .route(&format!("{P}/import"), post(import_project))
        .route("/api/boards", post(upload_board))
}

/// The most a checked board's rows may be, as the local app sends them: its file's limit (`BOARD_LIMIT`), with room for
/// what JSON adds around them.
const BOARD_BODY_LIMIT: usize = 320 * 1024 * 1024;

/// `POST /api/boards` {id, key, name?, holder, project, exported_at?, statuses, people, uploads, tables} → 201 the new
/// board. The local app's own call (ORR-1142): it checks a board's file first (`checkedBoard` in board-upload.ts), as
/// that's untrusted, and sends its rows here to be made a board, held by `holder` (`board_upload`). Its body is read
/// here, past the API's own limit, as a board's file is far bigger than any other request.
async fn upload_board(State(app): Shared, request: Request) -> Result<Response> {
    let too_large = || ApiError::too_large(format!("A board's file is {} MB at most", BOARD_BODY_LIMIT / 1024 / 1024));
    let actor = actor_of(request.headers());
    let body = to_bytes(request.into_body(), BOARD_BODY_LIMIT).await.map_err(|_| too_large())?;
    let body = body_of(&body);
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    let (Some(id), Some(key), Some(holder)) = (text("id"), text("key"), text("holder")) else {
        return Err(ApiError::bad_request("id, key and holder: the board's id and key, and who holds it"));
    };
    let mut conn = app.pool.acquire().await?;
    let upload = Upload { id, key, name: text("name"), holder, body: &body };
    let effects = board_upload::upload_board(&mut conn, &upload, &actor).await?;
    let value = Projects::new(&mut conn).project(id).await?;
    Ok(reply(StatusCode::CREATED, Some(value), effects))
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

/// `GET …/release-peers` → the ids of the projects sharing releases with this one: those drawing on it, and the one it
/// draws on (ORR-1174). The local app's own call, which tells their open pages when this one changes, as a source counts
/// the issues of those drawing on it and they show its releases. None for a project there isn't, as the store read it.
async fn release_peers(State(app): Shared, Path(project): Path<String>, headers: HeaderMap) -> Result<Response> {
    if !came_of(&headers).server {
        return Err(ApiError::forbidden("Only the local app asks which projects share releases"));
    }
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Projects::new(&mut conn).release_peers(&project).await?).into_response())
}

/// `GET …/row` → the project's row as it's stored (ORR-1174), for the local app's store, whose helpers read it to check
/// a project is there and for its prompts, instructions and release mode, without building its board. A 404 for a
/// project there isn't, as the store says it.
async fn project_row(State(app): Shared, Path(project): Path<String>, headers: HeaderMap) -> Result<Response> {
    if !came_of(&headers).server {
        return Err(ApiError::forbidden("Only the local app reads a project's row"));
    }
    let mut conn = app.pool.acquire().await?;
    let row = sqlx::query(&crate::db::sql("SELECT * FROM projects WHERE id = ?"))
        .bind(&project)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("No project \"{project}\"")))?;
    Ok(Json(crate::db::row_json(&row)).into_response())
}
