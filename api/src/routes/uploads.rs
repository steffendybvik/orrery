// Uploaded images: keeping one and reading it back, the handlers and the routes they answer (ORR-1048, ORR-1058).
use crate::board::uploads::{self, BODY_LIMIT, UPLOAD_LIMIT};
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of};
use crate::write::Effects;
use crate::{App, Shared};
use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/uploads", post(create_upload)).route("/api/uploads/{upload}", get(get_upload))
}

/// The 413 for a body too big to hold the largest image, in Nuxt's words.
fn too_large() -> ApiError {
    ApiError::too_large(format!("An image is {} MB at most", UPLOAD_LIMIT / 1024 / 1024))
}

/// Keeping an image. The body is read here, not by an extractor, so it can be bigger than axum's own 2 MB and a body
/// too big is refused in Nuxt's words: from its length before it's read, or once it's read past the limit.
async fn create_upload(State(app): Shared, request: Request) -> Result<Response> {
    let length = request.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    if length.is_some_and(|length| length > BODY_LIMIT) {
        return Err(too_large());
    }
    let actor = actor_of(request.headers());
    let body = to_bytes(request.into_body(), BODY_LIMIT).await.map_err(|_| too_large())?;
    let mut conn = app.pool.acquire().await?;
    let value = uploads::create_upload(&mut conn, &body_of(&body), &actor).await?;
    Ok(reply(StatusCode::CREATED, Some(value), Effects::default()))
}

async fn get_upload(State(app): Shared, Path(upload): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    uploads::upload(&mut conn, &upload).await
}

#[cfg(test)]
#[path = "uploads_tests.rs"]
mod tests;
