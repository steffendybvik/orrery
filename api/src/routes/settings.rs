// The orrery's settings: the handlers and the routes they answer (ORR-1048).
use crate::access::scope::{Across, Workspace};
use crate::access::seen::Seen;
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of, came_of, header, who_of};
use crate::work::settings::Settings;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use sqlx::AnyConnection;
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/settings", get(get_settings).patch(patch_settings))
}

/// The workspace whose settings these are (ORR-1107): the local app's call names a project (`?project=`, its
/// sessions' settings) or a workspace (`?workspace=`); anyone else's is the one it acts in.
async fn workspace_of(conn: &mut AnyConnection, headers: &HeaderMap, query: &HashMap<String, String>) -> Result<Workspace> {
    let named = |key: &str| query.get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if came_of(headers).server {
        if let Some(workspace) = named("workspace") {
            return Ok(Workspace::across(Across::Server, workspace));
        }
        if let Some(project) = named("project") {
            return Workspace::of_project(conn, &project).await;
        }
    }
    Seen::workspace(conn, headers).await
}

async fn get_settings(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    // Someone in no workspace yet (signed in, before making one) who names none still gets the page's settings, as
    // `default`'s; naming one they aren't in is a 404, as anywhere (ORR-1195).
    let named = header(&headers, "orrery-workspace").is_some_and(|w| !w.trim().is_empty()) || query.contains_key("workspace") || query.contains_key("project");
    let workspace = match workspace_of(&mut conn, &headers, &query).await {
        Ok(workspace) => workspace,
        Err(error) if named => return Err(error),
        Err(_) => Workspace::installation(),
    };
    let mut settings = Settings::of(&mut conn, workspace);
    let mut value = settings.get().await?;
    // The person's and the machine's (ORR-1387) are kept once, for the server's owner: anyone else signed in gets
    // their defaults, never the owner's starred and hidden projects, handle, terminal or agent.
    if who_of(&headers).is_some_and(|who| !who.owner) && !came_of(&headers).server {
        for (key, default) in owners_own() {
            value[key] = default;
        }
    }
    Ok(Json(value).into_response())
}

/// The settings that are the server's owner's own, in `settings` once for the whole server, with what anyone else gets.
fn owners_own() -> [(&'static str, serde_json::Value); 5] {
    use serde_json::{json, Value};
    [("starred", json!([])), ("hidden", json!([])), ("handle", Value::Null), ("terminal", json!("terminal")), ("agent", json!("claude"))]
}

async fn patch_settings(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let workspace = workspace_of(&mut conn, &headers, &query).await?;
    let mut settings = Settings::of(&mut conn, workspace);
    // What it sets off goes into the outbox inside its transaction (ORR-929).
    settings.outbox = Some(Outbox::new(actor_of(&headers)));
    let value = settings.update(&body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::OK, Some(value), std::mem::take(&mut settings.effects)))
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
