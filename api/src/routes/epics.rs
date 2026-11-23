// Epics: the handlers and the routes they answer (ORR-1048).
use crate::access::seen::Seen;
use crate::board::epics::Epics;
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of, header};
use sqlx::AnyConnection;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/epics", get(list_epics).post(create_epic)).route("/api/epics/{epic}", get(get_epic).patch(patch_epic).delete(delete_epic))
}

/// The epics of the workspace the request acts in, held to the boards the asker sees (ORR-1381).
async fn seen_epics<'c>(conn: &'c mut AnyConnection, headers: &HeaderMap) -> Result<Epics<'c>> {
    let seen = Seen::of(&mut *conn, headers).await?;
    let named = header(headers, "orrery-workspace").map(|w| w.trim().to_string()).filter(|w| !w.is_empty());
    let workspace = seen.pick(named.as_deref())?;
    let hidden = seen.hidden(&mut *conn).await?;
    let mut epics = Epics::of(conn, workspace);
    epics.hidden = hidden;
    Ok(epics)
}

/// The epics (ORR-1004): every one, one with its issues, and making, changing and deleting one.
async fn list_epics(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(seen_epics(&mut conn, &headers).await?.list().await?).into_response())
}

async fn get_epic(State(app): Shared, Path(epic): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut epics = seen_epics(&mut conn, &headers).await?;
    let id = epics.epic_id(&epic).await?;
    Ok(Json(epics.epic(id).await?).into_response())
}

async fn create_epic(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut epics = seen_epics(&mut conn, &headers).await?;
    epics.outbox = Some(Outbox::new(actor_of(&headers)));
    let id = epics.create(&body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut epics.effects);
    let value = epics.epic(id).await?;
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn patch_epic(State(app): Shared, Path(epic): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut epics = seen_epics(&mut conn, &headers).await?;
    let id = epics.epic_id(&epic).await?;
    epics.outbox = Some(Outbox::new(actor_of(&headers)));
    epics.update(id, &body_of(&body)).await?;
    let effects = std::mem::take(&mut epics.effects);
    let value = epics.epic(id).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn delete_epic(State(app): Shared, Path(epic): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut epics = seen_epics(&mut conn, &headers).await?;
    let id = epics.epic_id(&epic).await?;
    epics.outbox = Some(Outbox::new(actor_of(&headers)));
    epics.delete(id, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut epics.effects)))
}

#[cfg(test)]
#[path = "epics_tests.rs"]
mod tests;
