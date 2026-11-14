// The event log: the handlers and the routes they answer (ORR-1088). A page's error report (`POST /api/events/log`)
// stays the Nuxt server's, as it counts each sender in memory and scrubs secrets' values out; the line it makes of it,
// and each of its own, comes here (`PUT /api/events/log/lines`), as does its call to let old ones go.
use crate::access::seen::Seen;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, came_of};
use crate::work::event_log::{EventLog, Filter};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::Arc;

use crate::changes::Outbox;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/events/log", get(list_events))
        .route("/api/events/log/lines", put(write_line))
        .route("/api/events/log/prune", post(prune_events))
        .route("/api/events/log/{event}/resolve", post(resolve_event))
}

/// `?level=&kind=&project=&subject=&since=&open=1&limit=`: newest first, up to `limit` (200, 1000 at most).
async fn list_events(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let text = |key: &str| query.get(key).map(String::as_str);
    let filter = Filter {
        level: text("level"),
        kind: text("kind"),
        project: text("project"),
        subject: text("subject"),
        since: text("since"),
        open: matches!(text("open"), Some("1" | "true")),
        // `Number(limit) || undefined`: a blank is 0, so the default.
        limit: text("limit").map(|l| if l.trim().is_empty() { 0.0 } else { l.trim().parse::<f64>().unwrap_or(f64::NAN) }),
    };
    let mut conn = app.pool.acquire().await?;
    let mut value = EventLog::new(&mut conn).list(&filter).await?;
    Seen::of(&mut conn, &headers).await?.keep(&mut conn, &mut value, "project").await?;
    Ok(Json(value).into_response())
}

/// Only the local app's own call (`Orrery-Came: server`): it made the line, scrubbed of secrets' values.
fn local_app_only(headers: &HeaderMap) -> Result<()> {
    if came_of(headers).server {
        Ok(())
    } else {
        Err(ApiError::forbidden("Only the local app writes a line in the event log; a page reports an error with POST /api/events/log"))
    }
}

/// `{event, fresh}`: the line the local app made, written, and in the outbox for open pages' bells.
async fn write_line(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    local_app_only(&headers)?;
    let actor = actor_of(&headers);
    let mut conn = app.pool.acquire().await?;
    let mut log = EventLog::new(&mut conn);
    log.outbox = Some(Outbox::new(actor));
    let written = log.write(&body_of(&body)).await?;
    Ok(reply(StatusCode::CREATED, Some(written), log.effects()))
}

/// `{pruned}`: how many old lines went, as the local app asks on its start and every hour.
async fn prune_events(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    local_app_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let pruned = EventLog::new(&mut conn).prune().await?;
    Ok(Json(serde_json::json!({"pruned": pruned})).into_response())
}

/// The line, marked dealt with, with its repeats; each goes into the outbox for open pages' bells.
async fn resolve_event(State(app): Shared, Path(event): Path<String>, headers: HeaderMap) -> Result<Response> {
    let id: i64 = event.parse().map_err(|_| ApiError::not_found(format!("No event {event}")))?;
    let actor = actor_of(&headers);
    let mut conn = app.pool.acquire().await?;
    let mut log = EventLog::new(&mut conn);
    log.outbox = Some(Outbox::new(actor.clone()));
    let resolved = log.resolve(id, &actor).await?;
    Ok(reply(StatusCode::OK, Some(resolved), log.effects()))
}

#[cfg(test)]
#[path = "event_log_tests.rs"]
mod tests;
