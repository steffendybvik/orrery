// A project's milestones: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::changes::Outbox;
use crate::error::Result;
use crate::issues::Issues;
use crate::milestones::Milestones;
use crate::plans::Plans;
use crate::reply::reply;
use crate::request::{actor_of, body_of};
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
        .route(&format!("{P}/milestones"), get(list_milestones).post(create_milestone))
        .route(&format!("{P}/milestones/{{milestone}}"), get(get_milestone).patch(patch_milestone).delete(delete_milestone))
}

async fn list_milestones(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).milestones(&project).await?).into_response())
}

async fn get_milestone(State(app): Shared, Path((project, milestone)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).milestone(&project, &milestone).await?).into_response())
}

async fn create_milestone(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut milestones = Milestones::new(&mut conn);
    milestones.outbox = Some(Outbox::new(actor_of(&headers)));
    let id = milestones.create(&project, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut milestones.effects);
    let value = Plans::new(&mut Issues::new(&mut conn)).milestone(&project, &id).await?;
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn patch_milestone(State(app): Shared, Path((project, milestone)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut milestones = Milestones::new(&mut conn);
    milestones.outbox = Some(Outbox::new(actor_of(&headers)));
    let id = milestones.update(&project, &milestone, &body_of(&body)).await?;
    let effects = std::mem::take(&mut milestones.effects);
    let value = Plans::new(&mut Issues::new(&mut conn)).milestone(&project, &id).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn delete_milestone(State(app): Shared, Path((project, milestone)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut milestones = Milestones::new(&mut conn);
    milestones.outbox = Some(Outbox::new(actor_of(&headers)));
    milestones.delete(&project, &milestone, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut milestones.effects)))
}
