// The owner's chats as they're kept: the handlers and the routes they answer (ORR-1048).
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of};
use crate::work::chats::Chats;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/chats", get(list_chats)).route("/api/chats/{chat}", get(get_chat).put(keep_chat).delete(forget_chat))
}

async fn list_chats(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Chats::new(&mut conn).list().await?).into_response())
}

async fn keep_chat(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    chats.keep(&chat, &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut chats.effects)))
}

async fn forget_chat(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    chats.forget(&chat).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut chats.effects)))
}

async fn get_chat(State(app): Shared, Path(chat): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Chats::new(&mut conn).get(&chat).await?).into_response())
}
