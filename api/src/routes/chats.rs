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
use axum::routing::{get, post, put};
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/chats", get(list_chats))
        .route("/api/chats/{chat}", get(get_chat).put(keep_chat).delete(forget_chat))
        .route("/api/chats/{chat}/lines", post(add_message))
        .route("/api/chats/{chat}/lines/{message}", put(change_message))
        .route("/api/chats/{chat}/setting-requests", post(ask_setting))
        .route("/api/chats/{chat}/schedule-requests", post(ask_schedule))
        .route("/api/chats/{chat}/release-requests", post(ask_release))
        .route("/api/chats/{chat}/doc-requests", post(ask_doc))
}

/// `POST /api/chats/:chat/doc-requests` {doc, id?, project?, why?} → 201 the message asking (ORR-1100): the chat's
/// `create_doc` and `update_doc`, kept as a request the owner allows or denies on the chat's page.
async fn ask_doc(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    let asked = chats.ask_doc(&chat, &body_of(&body)).await?;
    Ok(reply(StatusCode::CREATED, Some(asked), std::mem::take(&mut chats.effects)))
}

/// `POST /api/chats/:chat/release-requests` {release, version?, project?, why?} → 201 the message asking (ORR-1100): the
/// chat's `create_release` and `update_release`, kept as a request the owner allows or denies on the chat's page.
async fn ask_release(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    let asked = chats.ask_release(&chat, &body_of(&body)).await?;
    Ok(reply(StatusCode::CREATED, Some(asked), std::mem::take(&mut chats.effects)))
}

/// `POST /api/chats/:chat/schedule-requests` {schedule, id?, project?, why?} → 201 the message asking (ORR-1100): the
/// chat's `create_schedule` and `update_schedule`, kept as a request the owner allows or denies on the chat's page.
async fn ask_schedule(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    let asked = chats.ask_schedule(&chat, &body_of(&body)).await?;
    Ok(reply(StatusCode::CREATED, Some(asked), std::mem::take(&mut chats.effects)))
}

/// `POST /api/chats/:chat/setting-requests` {setting, value, why?} → 201 the message asking (ORR-1100): the chat's
/// `update_settings`, kept as a request the owner allows or denies on the chat's page.
async fn ask_setting(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    let asked = chats.ask_setting(&chat, &body_of(&body)).await?;
    Ok(reply(StatusCode::CREATED, Some(asked), std::mem::take(&mut chats.effects)))
}

async fn add_message(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    let said = chats.add_message(&chat, &body_of(&body)).await?;
    Ok(reply(StatusCode::CREATED, Some(said), std::mem::take(&mut chats.effects)))
}

async fn change_message(State(app): Shared, Path((chat, message)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let Ok(id) = message.parse::<i64>() else { return Err(crate::error::ApiError::not_found(format!("No message {message} in chat {chat}"))) };
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    let changed = chats.change_message(&chat, id, &body_of(&body)).await?;
    Ok(reply(StatusCode::OK, Some(changed), std::mem::take(&mut chats.effects)))
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

#[cfg(test)]
#[path = "chats_tests.rs"]
mod tests;
