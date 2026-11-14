// The orrery's settings: the handlers and the routes they answer (ORR-1048).
use crate::access::seen::Seen;
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of};
use crate::work::settings::Settings;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/settings", get(get_settings).patch(patch_settings))
}

async fn get_settings(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    // Someone in no workspace yet (signed in, before making one) still gets the page's settings, with the statuses
    // orrery ships as `default` has them.
    let workspace = Seen::workspace(&mut conn, &headers).await.unwrap_or_else(|_| "default".into());
    let mut settings = Settings::new(&mut conn);
    settings.workspace = workspace;
    Ok(Json(settings.get().await?).into_response())
}

async fn patch_settings(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut settings = Settings::new(&mut conn);
    // What it sets off goes into the outbox inside its transaction (ORR-929).
    settings.outbox = Some(Outbox::new(actor_of(&headers)));
    let value = settings.update(&body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::OK, Some(value), std::mem::take(&mut settings.effects)))
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
