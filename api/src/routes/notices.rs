// The bell: the handlers and the routes they answer (ORR-1048).
use crate::access::seen::Seen;
use crate::error::{ApiError, Result};
use crate::request::{actor_of, body_of, came_of, owner_asking, who_of};
use crate::work::notices::{Asked, Notices};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/notices", get(list_notices))
        .route("/api/notices/changes", get(notice_changes))
        .route("/api/notices/clear", post(clear_notices))
        .route("/api/notices/read", post(read_notices))
}

/// The bell's reads (ORR-1005): whose it is, as `personOf` has it.
async fn list_notices(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut notices = Notices::new(&mut conn);
    let person = notices.person_of(who_of(&headers).as_ref(), &actor_of(&headers)).await?;
    let mut value = notices.notices(&Asked::of(&query), person.as_deref()).await?;
    Seen::listed(&mut conn, &headers).await?.keep(&mut conn, &mut value, "project").await?;
    Ok(Json(value).into_response())
}

async fn notice_changes(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut notices = Notices::new(&mut conn);
    let person = notices.person_of(who_of(&headers).as_ref(), &actor_of(&headers)).await?;
    let mut value = notices.changes(query.get("since").map(String::as_str), person.as_deref()).await?;
    Seen::listed(&mut conn, &headers).await?.keep(&mut conn, &mut value, "project").await?;
    Ok(Json(value).into_response())
}

/// Who clears the bell or marks it read (`notices.clear`): a member their own, else only the owner, as the routes'
/// `memberAsking` and `authorize` have it.
fn bell_keeper(headers: &HeaderMap) -> Result<Option<String>> {
    let actor = actor_of(headers);
    if let Some(person) = actor.person {
        return Ok(Some(person));
    }
    // orrery itself clears what a merge answered (ORR-1094): the Nuxt server's own work, never a request's.
    if owner_asking(headers) || (came_of(headers).server && !actor.asked && !actor.chat && !actor.untrusted && actor.name == "orrery") {
        return Ok(None);
    }
    let what = "Clear the bell or mark it read, or forget a session";
    let why = "What waits on the owner goes when they say.";
    let message = if actor.untrusted {
        format!("{what}: refused for an untrusted session (notices.clear). {why}")
    } else if actor.chat {
        format!("{what}: refused for the owner's chat (notices.clear). {why}")
    } else {
        format!("{what}: owner only for a session (notices.clear). {why} Send Orrery-Actor: <owner>")
    };
    Err(ApiError::refused_for("notices.clear", message))
}

/// The body with its comment `ids` kept to those on a project the asker sees (ORR-1388): one of another workspace's, or
/// of a board they aren't on, counts as one that isn't here, so the count says nothing of it and it's left as it is.
async fn seen_ids(conn: &mut sqlx::AnyConnection, headers: &HeaderMap, mut body: Value) -> Result<Value> {
    let Some(Value::Array(ids)) = body.get("ids") else { return Ok(body) };
    let hidden = Seen::of(conn, headers).await?.hidden(conn).await?;
    if hidden.is_empty() || ids.is_empty() {
        return Ok(body);
    }
    let mut kept = Vec::new();
    for id in ids.clone() {
        let Some(n) = id.as_i64().or_else(|| id.as_str().and_then(|s| s.parse().ok())) else {
            kept.push(id);
            continue;
        };
        let project: Option<String> =
            sqlx::query_scalar(crate::db::sql("SELECT project FROM comments WHERE id = ?")).bind(n).fetch_optional(&mut *conn).await?;
        if project.is_some_and(|p| !hidden.contains(&p)) {
            kept.push(id);
        }
    }
    // Nothing seen left: an id that's nobody's, which changes nothing, rather than an empty list, which is a 400.
    if kept.is_empty() {
        kept.push(Value::from(-1));
    }
    body["ids"] = Value::Array(kept);
    Ok(body)
}

async fn clear_notices(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let person = bell_keeper(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let body = seen_ids(&mut conn, &headers, body_of(&body)).await?;
    let cleared = Notices::new(&mut conn).clear(&body, person.as_deref()).await?;
    Ok(Json(json!({"cleared": cleared})).into_response())
}

async fn read_notices(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let person = bell_keeper(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let body = seen_ids(&mut conn, &headers, body_of(&body)).await?;
    let read = Notices::new(&mut conn).read(&body, person.as_deref()).await?;
    Ok(Json(json!({"read": read})).into_response())
}

#[cfg(test)]
#[path = "notices_tests.rs"]
mod tests;
