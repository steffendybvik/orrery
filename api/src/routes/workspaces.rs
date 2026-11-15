// Workspaces: the handlers and the routes they answer (ORR-1108).
use crate::access::people::People;
use crate::access::seen::Seen;
use crate::access::workspaces::Workspaces;
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of, who_of};
use crate::routes::people::signed_in;
use crate::write::Effects;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/workspaces", get(list_workspaces).post(create_workspace))
        .route("/api/workspaces/{workspace}", patch(patch_workspace).delete(delete_workspace))
}

/// `GET /api/workspaces` → the workspaces the asker reaches, `default` first: {id, name, color, role}.
async fn list_workspaces(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let seen = Seen::of(&mut conn, &headers).await?;
    let person = Seen::person(&mut conn, who_of(&headers).as_ref(), &actor_of(&headers)).await?;
    Ok(Json(Workspaces::new(&mut conn).list(&seen, person.as_deref()).await?).into_response())
}

/// `POST /api/workspaces` {name, color?} → 201 the workspace, the asker its owner.
async fn create_workspace(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let person = Seen::person(&mut conn, who_of(&headers).as_ref(), &actor_of(&headers)).await?;
    let made = Workspaces::new(&mut conn).create(&body_of(&body), person.as_deref()).await?;
    Ok(reply(StatusCode::CREATED, Some(made), Effects::default()))
}

/// `PATCH /api/workspaces/:workspace` {name?, color?} → the workspace: its owners' to change.
async fn patch_workspace(State(app): Shared, Path(workspace): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let person = Seen::person(&mut conn, who_of(&headers).as_ref(), &actor_of(&headers)).await?;
    let changed = Workspaces::new(&mut conn).update(&workspace, &body_of(&body), person.as_deref()).await?;
    Ok(reply(StatusCode::OK, Some(changed), Effects::default()))
}

/// `DELETE /api/workspaces/:workspace` {confirm} → 204: its owner, signed in through a browser, deleting it with
/// everything in it (`People::delete_own_workspace`, ORR-1203); never a session, the chat or an agent key.
async fn delete_workspace(State(app): Shared, Path(workspace): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let person = signed_in(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    people.outbox = Some(Outbox::new(actor_of(&headers)));
    people.delete_own_workspace(&person, &workspace, &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut people.effects)))
}

#[cfg(test)]
#[path = "workspaces_tests.rs"]
mod tests;
