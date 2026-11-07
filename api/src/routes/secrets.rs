// Reading secrets, never a value: the handlers and the routes they answer (ORR-1048).
use crate::access::secrets::Secrets;
use crate::error::Result;
use crate::{App, Shared};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/secrets", get(list_secrets)).route("/api/secrets/{name}", get(get_secret))
}

async fn list_secrets(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Secrets::new(&mut conn).list().await?).into_response())
}

async fn get_secret(State(app): Shared, Path(name): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Secrets::new(&mut conn).secret(&name).await?).into_response())
}

#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;
