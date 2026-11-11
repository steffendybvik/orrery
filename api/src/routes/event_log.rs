// The event log's reads and resolve: the handlers and the routes they answer (ORR-1088). A page's error report
// (`POST /api/events/log`) stays the Nuxt server's, as it counts each sender in memory and scrubs secrets' values out.
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::actor_of;
use crate::work::event_log::{EventLog, Filter};
use crate::{App, Shared};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::Arc;

use crate::changes::Outbox;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/events/log", get(list_events)).route("/api/events/log/{event}/resolve", post(resolve_event))
}

/// `?level=&kind=&project=&subject=&since=&open=1&limit=`: newest first, up to `limit` (200, 1000 at most).
async fn list_events(State(app): Shared, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
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
    Ok(Json(EventLog::new(&mut conn).list(&filter).await?).into_response())
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
