// Pull requests as orrery keeps them, the GitHub poll's writes, and a pull's risk: the handlers and the routes they
// answer (ORR-1048).
use super::P;
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of, owner_asking};
use crate::work::pull_poll::PullPoll;
use crate::work::pulls::{check_rating, pull_number, Pulls};
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
        .route("/api/pulls/{owner}/{name}/{number}", get(get_pull).put(keep_pull))
        .route("/api/pulls/{owner}/{name}", get(kept_repo).put(polled_repo))
        .route("/api/pulls/{owner}/{name}/error", put(polled_repo_failed))
        .route("/api/pulls/{owner}/{name}/history", put(polled_repo_history))
        .route("/api/pulls/forget", post(forget_pulls))
        .route(&format!("{P}/issues/{{issue}}/pulls/{{owner}}/{{name}}/{{number}}/risk"), put(rate_pull))
}

async fn get_pull(State(app): Shared, Path((owner, name, number)): Path<(String, String, String)>, headers: HeaderMap) -> Result<Response> {
    let number = pull_number(&number)?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Pulls::new(&mut conn).for_pull(&format!("{owner}/{name}"), number, owner_asking(&headers)).await?).into_response())
}

/// A repo's GitHub poll, its failure, its history page and letting go of what's done (ORR-952): the local app's poll,
/// written ahead of the swap.
async fn polled_repo(State(app): Shared, Path((owner, name)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut poll = PullPoll::new(&mut conn);
    poll.outbox = Some(Outbox::new(actor_of(&headers)));
    poll.polled(&format!("{owner}/{name}"), &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut poll.effects)))
}

/// What the local app's poll reads of a repo before it polls it (ORR-1153): not routed, so only the local app asks.
async fn kept_repo(State(app): Shared, Path((owner, name)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(PullPoll::new(&mut conn).kept(&format!("{owner}/{name}")).await?).into_response())
}

async fn polled_repo_failed(State(app): Shared, Path((owner, name)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut poll = PullPoll::new(&mut conn);
    poll.outbox = Some(Outbox::new(actor_of(&headers)));
    poll.failed(&format!("{owner}/{name}"), &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut poll.effects)))
}

async fn polled_repo_history(State(app): Shared, Path((owner, name)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut poll = PullPoll::new(&mut conn);
    poll.outbox = Some(Outbox::new(actor_of(&headers)));
    poll.history(&format!("{owner}/{name}"), &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut poll.effects)))
}

async fn forget_pulls(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut poll = PullPoll::new(&mut conn);
    poll.outbox = Some(Outbox::new(actor_of(&headers)));
    let value = poll.forget(&body_of(&body)).await?;
    Ok(reply(StatusCode::OK, Some(value), std::mem::take(&mut poll.effects)))
}

/// Keeps the PR on the issues it names (ORR-952): the local app's poll, written ahead of the swap.
async fn keep_pull(State(app): Shared, Path((owner, name, number)): Path<(String, String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let number = pull_number(&number)?;
    let mut conn = app.pool.acquire().await?;
    let mut pulls = Pulls::new(&mut conn);
    pulls.outbox = Some(Outbox::new(actor_of(&headers)));
    pulls.remember(&format!("{owner}/{name}"), number, &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut pulls.effects)))
}

async fn rate_pull(
    State(app): Shared,
    Path((project, issue, owner, name, number)): Path<(String, String, String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    let number = pull_number(&number)?;
    let risk = check_rating(&body_of(&body))?;
    let mut conn = app.pool.acquire().await?;
    let mut pulls = Pulls::new(&mut conn);
    pulls.outbox = Some(Outbox::new(actor_of(&headers)));
    let value = pulls.rate(&project, &issue, &format!("{owner}/{name}"), number, risk, owner_asking(&headers)).await?;
    Ok(reply(StatusCode::OK, Some(value), std::mem::take(&mut pulls.effects)))
}

#[cfg(test)]
#[path = "pulls_tests.rs"]
mod tests;
