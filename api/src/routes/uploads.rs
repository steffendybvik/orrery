// Uploaded images: keeping one and reading it back, the handlers and the routes they answer (ORR-1048, ORR-1058).
use crate::access::seen::Seen;
use crate::board::uploads::{self, BODY_LIMIT, UPLOAD_LIMIT};
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, header as header_of};
use crate::work::settings::owner_only;
use crate::write::Effects;
use crate::{App, Shared};
use axum::body::to_bytes;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/uploads", post(create_upload).get(list_uploads).delete(sweep_uploads))
        .route("/api/uploads/{upload}", get(get_upload).delete(delete_upload))
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
    let mut conn = app.pool.acquire().await?;
    // Kept in the workspace the request acts in (ORR-1226).
    let seen = Seen::of(&mut conn, request.headers()).await?;
    let named = header_of(request.headers(), "orrery-workspace").map(|w| w.trim().to_string()).filter(|w| !w.is_empty());
    let workspace = uploads::workspace_for(&mut conn, &seen, named.as_deref()).await?;
    let body = to_bytes(request.into_body(), BODY_LIMIT).await.map_err(|_| too_large())?;
    let value = uploads::create_upload(&mut conn, &body_of(&body), &actor, &workspace).await?;
    Ok(reply(StatusCode::CREATED, Some(value), Effects::default()))
}

/// An image, to those in its workspace alone (ORR-1226); the Nuxt server's own reads see every one.
async fn get_upload(State(app): Shared, Path(upload): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let seen = Seen::of(&mut conn, &headers).await?;
    uploads::upload(&mut conn, &upload, &seen).await
}

/// The workspace a request about images acts in: the one it names (`Orrery-Workspace`), or its own (ORR-1226).
async fn workspace_of(conn: &mut sqlx::AnyConnection, headers: &HeaderMap) -> Result<String> {
    let seen = Seen::of(conn, headers).await?;
    let named = header_of(headers, "orrery-workspace").map(|w| w.trim().to_string()).filter(|w| !w.is_empty());
    uploads::workspace_for(conn, &seen, named.as_deref()).await
}

/// Whether `?unused=1` (or `true`) was sent.
fn unused(query: &HashMap<String, String>) -> bool {
    query.get("unused").is_some_and(|u| u == "1" || u == "true")
}

/// The workspace's images (ORR-1250), each with whether anything shows it; `?unused=1` lists only those nothing shows
/// that are more than a day old, with their count and size, for App settings → Workspace → Storage.
async fn list_uploads(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers).await?;
    Ok(reply(StatusCode::OK, Some(uploads::list_uploads(&mut conn, &workspace, unused(&query)).await?), Effects::default()))
}

/// Removing one image, the owner's: refused (409) while something still shows it.
async fn delete_upload(State(app): Shared, Path(upload): Path<String>, headers: HeaderMap) -> Result<Response> {
    owner_only(&actor_of(&headers))?;
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers).await?;
    uploads::delete_upload(&mut conn, &upload, &workspace).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Removing every unused image at once (`?unused=1`, which must be sent), the owner's → `{count, size}` removed, and
/// whether the SQLite file was compacted to give the room back (`compacted`), when that much came free.
async fn sweep_uploads(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    owner_only(&actor_of(&headers))?;
    if !unused(&query) {
        return Err(ApiError::bad_request("Send ?unused=1: only the images nothing shows are removed at once"));
    }
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers).await?;
    let mut removed = uploads::sweep_uploads(&mut conn, &workspace).await?;
    let compacted = removed["count"].as_u64().unwrap_or(0) > 0 && crate::routes::database::compact_file(&mut conn, false).await?;
    removed["compacted"] = compacted.into();
    Ok(reply(StatusCode::OK, Some(removed), Effects::default()))
}

#[cfg(test)]
#[path = "uploads_tests.rs"]
mod tests;
