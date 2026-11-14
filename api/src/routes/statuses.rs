// Issue statuses: the handlers and the routes they answer (ORR-1048).
use crate::access::seen::Seen;
use crate::board::statuses::Statuses;
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/statuses", get(list_statuses).post(create_status)).route("/api/statuses/{status}", patch(patch_status).delete(delete_status))
}

/// Runs `work` with the statuses on a connection of the pool's, as `with_docs` does with the docs.
/// The workspace's statuses, the one the request acts in (ORR-1107).
macro_rules! with_statuses {
    ($app:expr, $headers:expr, read |$statuses:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let workspace = Seen::workspace(&mut conn, &$headers).await?;
        let mut $statuses = Statuses::of(&mut *conn, workspace);
        let value = $work;
        (value, std::mem::take(&mut $statuses.effects))
    }};
    // A write: what it sets off goes into the outbox inside its transaction (ORR-929).
    ($app:expr, $headers:expr, |$statuses:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let workspace = Seen::workspace(&mut conn, &$headers).await?;
        let mut $statuses = Statuses::of(&mut *conn, workspace);
        $statuses.outbox = Some(Outbox::new(actor_of(&$headers)));
        let value = $work;
        (value, std::mem::take(&mut $statuses.effects))
    }};
}

async fn list_statuses(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let (value, _) = with_statuses!(app, headers, read | statuses | statuses.list().await?);
    Ok(Json(value).into_response())
}

async fn create_status(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (value, effects) = with_statuses!(app, headers, |statuses| statuses.create(&body_of(&body), &actor_of(&headers)).await?);
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn patch_status(State(app): Shared, Path(status): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (value, effects) = with_statuses!(app, headers, |statuses| statuses.update(&status, &body_of(&body), &actor_of(&headers)).await?);
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn delete_status(State(app): Shared, Path(status): Path<String>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap) -> Result<Response> {
    let into = query.get("into").map(String::as_str).filter(|s| !s.is_empty());
    let ((), effects) = with_statuses!(app, headers, |statuses| statuses.delete(&status, into, &actor_of(&headers)).await?);
    Ok(reply(StatusCode::NO_CONTENT, None, effects))
}

#[cfg(test)]
#[path = "statuses_tests.rs"]
mod tests;
