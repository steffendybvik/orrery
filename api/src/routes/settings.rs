// The orrery's settings: the handlers and the routes they answer (ORR-1048).
use crate::access::seen::Seen;
use crate::changes::Outbox;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, came_of};
use crate::work::settings::Settings;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use sqlx::{AnyConnection, Row};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/settings", get(get_settings).patch(patch_settings))
}

/// The workspace whose settings these are (ORR-1107): the local app's call names a project (`?project=`, its
/// sessions' settings) or a workspace (`?workspace=`); anyone else's is the one it acts in.
async fn workspace_of(conn: &mut AnyConnection, headers: &HeaderMap, query: &HashMap<String, String>) -> Result<String> {
    let named = |key: &str| query.get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if came_of(headers).server {
        if let Some(workspace) = named("workspace") {
            return Ok(workspace);
        }
        if let Some(project) = named("project") {
            let row = sqlx::query(&sql("SELECT workspace FROM projects WHERE id = ?")).bind(&project).fetch_optional(&mut *conn).await?;
            return row.map(|r| r.get::<String, _>("workspace")).ok_or_else(|| ApiError::not_found(format!("No project \"{project}\"")));
        }
    }
    Seen::workspace(conn, headers).await
}

async fn get_settings(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    // Someone in no workspace yet (signed in, before making one) still gets the page's settings, as `default`'s.
    let workspace = workspace_of(&mut conn, &headers, &query).await.unwrap_or_else(|_| "default".into());
    let mut settings = Settings::new(&mut conn);
    settings.workspace = workspace;
    Ok(Json(settings.get().await?).into_response())
}

async fn patch_settings(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers, &query).await?;
    let mut settings = Settings::new(&mut conn);
    settings.workspace = workspace;
    // What it sets off goes into the outbox inside its transaction (ORR-929).
    settings.outbox = Some(Outbox::new(actor_of(&headers)));
    let value = settings.update(&body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::OK, Some(value), std::mem::take(&mut settings.effects)))
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
