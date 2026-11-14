// Reading secrets, never a value, and keeping what the local app sealed: the handlers and the routes they answer
// (ORR-1048, ORR-1096).
use crate::access::secrets::Secrets;
use crate::access::seen::Seen;
use crate::changes::Outbox;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, came_of};
use crate::work::secrets::SecretWrites;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use sqlx::{AnyConnection, Row};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/secrets", get(list_secrets))
        .route("/api/secrets/{name}", get(get_secret))
        .route("/api/secrets/{name}/sealed", get(read_sealed).put(keep_sealed).delete(forget_sealed))
        .route("/api/sealed-secrets", get(read_all_sealed))
        .route("/api/secrets/{name}/uses", post(keep_use))
}

/// The workspace a call is about (ORR-1107). The local app's names it: `?project=`'s, as egress and orrery's own
/// requests name the project they're for, or `?workspace=`, or `Orrery-Workspace`, else `default`. Anyone else's is
/// the one it acts in (`Seen::workspace`).
async fn workspace_of(conn: &mut AnyConnection, headers: &HeaderMap, query: &HashMap<String, String>) -> Result<String> {
    if !came_of(headers).server {
        return Seen::workspace(conn, headers).await;
    }
    let named = |key: &str| query.get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(workspace) = named("workspace") {
        return Ok(workspace);
    }
    match named("project").as_deref() {
        Some(project) => sqlx::query(&sql("SELECT workspace FROM projects WHERE id = ?"))
            .bind(project)
            .fetch_optional(&mut *conn)
            .await?
            .map(|r| r.get::<String, _>("workspace"))
            .ok_or_else(|| ApiError::not_found(format!("No project \"{project}\""))),
        None => Seen::workspace(conn, headers).await,
    }
}

/// The secret as the local app sealed it (ORR-1096): set or narrowed there, kept here.
async fn keep_sealed(
    State(app): Shared,
    Path(name): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers, &query).await?;
    let mut writes = SecretWrites::new(&mut conn);
    writes.workspace = workspace;
    writes.outbox = Some(Outbox::new(actor_of(&headers)));
    writes.keep(&name, &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut writes.effects)))
}

async fn forget_sealed(State(app): Shared, Path(name): Path<String>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers, &query).await?;
    let mut writes = SecretWrites::new(&mut conn);
    writes.workspace = workspace;
    writes.outbox = Some(Outbox::new(actor_of(&headers)));
    writes.forget(&name).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut writes.effects)))
}

/// A use of the secret the local app made (ORR-1096): egress, or orrery's own request.
async fn keep_use(
    State(app): Shared,
    Path(name): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers, &query).await?;
    let mut writes = SecretWrites::new(&mut conn);
    writes.workspace = workspace;
    writes.outbox = Some(Outbox::new(actor_of(&headers)));
    writes.used(&name, &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut writes.effects)))
}

/// Only the local app's own call (`Orrery-Came: server`, which only the token's holder sends): it holds the key.
fn local_app_only(headers: &HeaderMap) -> Result<()> {
    if came_of(headers).server {
        Ok(())
    } else {
        Err(ApiError::forbidden("Only the local app reads a secret as sealed; GET /api/secrets lists them without their values"))
    }
}

/// The secret's row as sealed, its value ciphertext, for the local app to open (ORR-1143): egress, its own requests.
async fn read_sealed(State(app): Shared, Path(name): Path<String>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers, &query).await?;
    let row = Secrets::of(&mut conn, workspace).sealed(&name).await?.ok_or_else(|| ApiError::not_found(format!("No secret {name}")))?;
    Ok(Json(row).into_response())
}

/// Every secret's row as sealed (ORR-1143), for the local app's scrubber.
async fn read_all_sealed(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Secrets::new(&mut conn).all_sealed().await?).into_response())
}

async fn list_secrets(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers, &query).await?;
    Ok(Json(Secrets::of(&mut conn, workspace).list().await?).into_response())
}

async fn get_secret(State(app): Shared, Path(name): Path<String>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers, &query).await?;
    Ok(Json(Secrets::of(&mut conn, workspace).secret(&name).await?).into_response())
}

#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;
