// Reading secrets, never a value, and keeping what the local app sealed: the handlers and the routes they answer
// (ORR-1048, ORR-1096).
use crate::access::secrets::Secrets;
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of};
use crate::work::secrets::SecretWrites;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/secrets", get(list_secrets))
        .route("/api/secrets/{name}", get(get_secret))
        .route("/api/secrets/{name}/sealed", put(keep_sealed).delete(forget_sealed))
        .route("/api/secrets/{name}/uses", post(keep_use))
}

/// The secret as the local app sealed it (ORR-1096): set or narrowed there, kept here.
async fn keep_sealed(State(app): Shared, Path(name): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut writes = SecretWrites::new(&mut conn);
    writes.outbox = Some(Outbox::new(actor_of(&headers)));
    writes.keep(&name, &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut writes.effects)))
}

async fn forget_sealed(State(app): Shared, Path(name): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut writes = SecretWrites::new(&mut conn);
    writes.outbox = Some(Outbox::new(actor_of(&headers)));
    writes.forget(&name).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut writes.effects)))
}

/// A use of the secret the local app made (ORR-1096): egress, or orrery's own request.
async fn keep_use(State(app): Shared, Path(name): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut writes = SecretWrites::new(&mut conn);
    writes.outbox = Some(Outbox::new(actor_of(&headers)));
    writes.used(&name, &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut writes.effects)))
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
