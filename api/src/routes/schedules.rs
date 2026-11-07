// Reading schedules: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::error::Result;
use crate::work::presets::Presets;
use crate::work::schedules::Schedules;
use crate::{App, Shared};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(&format!("{P}/schedules"), get(list_schedules))
        .route(&format!("{P}/schedules/{{schedule}}"), get(get_schedule))
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

async fn schedules_across(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Schedules::new(&mut conn).across().await?).into_response())
}

#[cfg(test)]
#[path = "schedules_tests.rs"]
mod tests;
