// The owner's feature counts: the handlers and the routes they answer (ORR-1089). Counting a use (`POST /api/usage`)
// stays the Nuxt server's, in memory; it sends what gathered with `PUT`.
use crate::error::{ApiError, Result};
use crate::request::{actor_of, body_of, came_of, owner_asking};
use crate::work::settings::owner_only;
use crate::work::usage::Usage;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/usage", get(list_usage).put(keep_usage).delete(forget_usage))
}

/// `{on, features}`, the owner's alone; the router adds `allowed`, the server's own setting.
async fn list_usage(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    if !owner_asking(&headers) {
        return Err(ApiError::forbidden("How the features are used is the owner's to read"));
    }
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Usage::new(&mut conn).list().await?).into_response())
}

/// What the Nuxt server gathered in memory, sent once a minute: only its own call (`Orrery-Came: server`).
async fn keep_usage(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    if !came_of(&headers).server {
        return Err(ApiError::forbidden("Only the local app sends the feature counts it gathered"));
    }
    let mut conn = app.pool.acquire().await?;
    Usage::new(&mut conn).keep(&body_of(&body)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Forgets every count, as turning counting off offers to: the owner's (`settings.write`).
async fn forget_usage(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    owner_only(&actor_of(&headers))?;
    let mut conn = app.pool.acquire().await?;
    Usage::new(&mut conn).forget().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
