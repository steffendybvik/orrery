// Comments on a milestone or an epic: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::access::seen::Seen;
use crate::board::comments::comment_id;
use crate::board::epics::Epics;
use crate::board::threads::{Thread, Threads};
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of};
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
        .route("/api/epics/{epic}/comments", get(list_epic_comments).post(create_epic_comment))
        .route("/api/epics/{epic}/comments/{comment}", patch(patch_epic_comment).delete(delete_epic_comment))
        .route(&format!("{P}/milestones/{{milestone}}/comments"), get(list_milestone_comments).post(create_milestone_comment))
        .route(&format!("{P}/milestones/{{milestone}}/comments/{{comment}}"), patch(patch_milestone_comment).delete(delete_milestone_comment))
}

/// A milestone's or an epic's comments (ORR-1004): as the routes read their URL, the comment's id before the store
/// finds the milestone, and the epic before the comment.
async fn milestone_thread(threads: &mut Threads<'_>, project: &str, milestone: &str) -> Result<Thread> {
    threads.milestone(project, milestone).await
}

/// An epic of the workspace the request acts in (ORR-1107): another's is a 404.
async fn epic_thread(threads: &mut Threads<'_>, epic: &str, headers: &HeaderMap) -> Result<Thread> {
    let workspace = Seen::workspace(&mut *threads.conn, headers).await?;
    Ok(Thread::Epic(Epics::of(&mut *threads.conn, workspace).epic_id(epic).await?))
}

async fn list_milestone_comments(State(app): Shared, Path((project, milestone)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut threads = Threads::new(&mut conn);
    let thread = milestone_thread(&mut threads, &project, &milestone).await?;
    Ok(Json(threads.list(&thread).await?).into_response())
}

async fn list_epic_comments(State(app): Shared, Path(epic): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut threads = Threads::new(&mut conn);
    let thread = epic_thread(&mut threads, &epic, &headers).await?;
    Ok(Json(threads.list(&thread).await?).into_response())
}

async fn add_to_thread(mut threads: Threads<'_>, thread: Thread, headers: &HeaderMap, body: &Bytes) -> Result<Response> {
    threads.outbox = Some(Outbox::new(actor_of(headers)));
    let id = threads.add(&thread, &body_of(body), &actor_of(headers)).await?;
    let effects = std::mem::take(&mut threads.effects);
    let value = threads.comment(&thread, id).await?;
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn edit_in_thread(mut threads: Threads<'_>, thread: Thread, id: i64, headers: &HeaderMap, body: &Bytes) -> Result<Response> {
    threads.outbox = Some(Outbox::new(actor_of(headers)));
    threads.edit(&thread, id, &body_of(body), &actor_of(headers)).await?;
    let effects = std::mem::take(&mut threads.effects);
    let value = threads.comment(&thread, id).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn remove_from_thread(mut threads: Threads<'_>, thread: Thread, id: i64, headers: &HeaderMap) -> Result<Response> {
    threads.outbox = Some(Outbox::new(actor_of(headers)));
    threads.remove(&thread, id, &actor_of(headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut threads.effects)))
}

async fn create_milestone_comment(State(app): Shared, Path((project, milestone)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut threads = Threads::new(&mut conn);
    let thread = milestone_thread(&mut threads, &project, &milestone).await?;
    add_to_thread(threads, thread, &headers, &body).await
}

async fn create_epic_comment(State(app): Shared, Path(epic): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut threads = Threads::new(&mut conn);
    let thread = epic_thread(&mut threads, &epic, &headers).await?;
    add_to_thread(threads, thread, &headers, &body).await
}

async fn patch_milestone_comment(
    State(app): Shared,
    Path((project, milestone, comment)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    let id = comment_id(&comment)?;
    let mut conn = app.pool.acquire().await?;
    let mut threads = Threads::new(&mut conn);
    let thread = milestone_thread(&mut threads, &project, &milestone).await?;
    edit_in_thread(threads, thread, id, &headers, &body).await
}

async fn patch_epic_comment(State(app): Shared, Path((epic, comment)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut threads = Threads::new(&mut conn);
    let thread = epic_thread(&mut threads, &epic, &headers).await?;
    let id = comment_id(&comment)?;
    edit_in_thread(threads, thread, id, &headers, &body).await
}

async fn delete_milestone_comment(
    State(app): Shared,
    Path((project, milestone, comment)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    let id = comment_id(&comment)?;
    let mut conn = app.pool.acquire().await?;
    let mut threads = Threads::new(&mut conn);
    let thread = milestone_thread(&mut threads, &project, &milestone).await?;
    remove_from_thread(threads, thread, id, &headers).await
}

async fn delete_epic_comment(State(app): Shared, Path((epic, comment)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut threads = Threads::new(&mut conn);
    let thread = epic_thread(&mut threads, &epic, &headers).await?;
    let id = comment_id(&comment)?;
    remove_from_thread(threads, thread, id, &headers).await
}

#[cfg(test)]
#[path = "threads_tests.rs"]
mod tests;
