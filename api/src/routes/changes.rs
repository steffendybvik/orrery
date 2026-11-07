// The outbox feed (`GET /api/changes`): the handlers and the routes they answer (ORR-1048).
use crate::error::Result;
use crate::{changes, header, App, Shared};
use axum::extract::{Query, State};
use axum::http::header::ACCEPT;
use axum::http::HeaderMap;
use axum::response::sse::{KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/changes", get(list_changes))
}

/// `GET /api/changes?after=<id>`: a page of the outbox as JSON, or, asked with `Accept: text/event-stream`, the rows as
/// server-sent events, oldest first, then live. A reconnecting stream's `Last-Event-ID` stands for `after`.
async fn list_changes(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let streamed = headers.get(ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/event-stream"));
    if streamed {
        let after = changes::cursor(header(&headers, "last-event-id").or_else(|| query.get("after").cloned()).as_deref())?;
        return Ok(Sse::new(changes::stream(app.pool.clone(), after)).keep_alive(KeepAlive::default()).into_response());
    }
    let mut conn = app.pool.acquire().await?;
    Ok(Json(changes::after(&mut conn, query.get("after").map(String::as_str)).await?).into_response())
}
