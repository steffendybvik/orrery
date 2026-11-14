// A project's docs, their sections and revisions: the handlers and the routes they answer (ORR-1048).
use super::P;
use crate::board::docs::Docs;
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(&format!("{P}/docs"), get(list_docs).post(create_doc))
        .route(&format!("{P}/docs/{{doc}}"), get(get_doc).put(put_doc).patch(patch_doc).delete(delete_doc))
        .route(&format!("{P}/docs/{{doc}}/revisions"), get(list_revisions))
        .route(&format!("{P}/docs/{{doc}}/revisions/{{revision}}"), get(get_revision))
        .route(&format!("{P}/docs/{{doc}}/revisions/{{revision}}/restore"), post(restore_revision))
        .route(&format!("{P}/deleted-docs"), get(deleted_docs))
        .route(&format!("{P}/doc-sections"), get(list_sections).post(create_section))
        .route(&format!("{P}/doc-sections/{{section}}"), patch(patch_section).delete(delete_section))
}

/// Runs `work` with the docs on a connection of the pool's: what it gives back, and what it changed.
macro_rules! with_docs {
    ($app:expr, |$docs:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let mut $docs = Docs::new(&mut *conn);
        let value = $work;
        (value, std::mem::take(&mut $docs.effects))
    }};
    // A write: what it sets off goes into the outbox inside its transaction (ORR-929).
    ($app:expr, $headers:expr, |$docs:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let mut $docs = Docs::new(&mut *conn);
        $docs.outbox = Some(Outbox::new(actor_of(&$headers)));
        let value = $work;
        (value, std::mem::take(&mut $docs.effects))
    }};
}

async fn list_docs(State(app): Shared, Path(project): Path<String>, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let (value, _) = with_docs!(app, |docs| docs.list(&project, query.get("q").map(String::as_str)).await?);
    Ok(Json(value).into_response())
}

async fn create_doc(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (value, effects) = with_docs!(app, headers, |docs| docs.create(&project, &body_of(&body), &actor_of(&headers)).await?);
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn get_doc(State(app): Shared, Path((project, doc)): Path<(String, String)>) -> Result<Response> {
    let (value, _) = with_docs!(app, |docs| docs.doc(&project, &doc).await?);
    Ok(Json(value).into_response())
}

async fn put_doc(State(app): Shared, Path((project, doc)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let ((value, made), effects) = with_docs!(app, headers, |docs| docs.put(&project, &doc, &body_of(&body), &actor_of(&headers)).await?);
    Ok(reply(if made { StatusCode::CREATED } else { StatusCode::OK }, Some(value), effects))
}

async fn patch_doc(State(app): Shared, Path((project, doc)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (value, effects) = with_docs!(app, headers, |docs| docs.update(&project, &doc, &body_of(&body), &actor_of(&headers)).await?);
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn delete_doc(State(app): Shared, Path((project, doc)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let ((), effects) = with_docs!(app, headers, |docs| docs.delete(&project, &doc, &actor_of(&headers)).await?);
    Ok(reply(StatusCode::NO_CONTENT, None, effects))
}

async fn list_revisions(State(app): Shared, Path((project, doc)): Path<(String, String)>) -> Result<Response> {
    let (value, _) = with_docs!(app, |docs| docs.revisions(&project, &doc).await?);
    Ok(Json(value).into_response())
}

async fn get_revision(State(app): Shared, Path((project, doc, revision)): Path<(String, String, String)>) -> Result<Response> {
    let (value, _) = with_docs!(app, |docs| docs.revision(&project, &doc, &revision).await?);
    Ok(Json(value).into_response())
}

async fn restore_revision(State(app): Shared, Path((project, doc, revision)): Path<(String, String, String)>, headers: HeaderMap) -> Result<Response> {
    let ((value, made), effects) = with_docs!(app, headers, |docs| docs.restore(&project, &doc, &revision, &actor_of(&headers)).await?);
    Ok(reply(if made { StatusCode::CREATED } else { StatusCode::OK }, Some(value), effects))
}

async fn deleted_docs(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let (value, _) = with_docs!(app, |docs| docs.deleted(&project).await?);
    Ok(Json(value).into_response())
}

async fn list_sections(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let (value, _) = with_docs!(app, |docs| docs.sections(&project).await?);
    Ok(Json(value).into_response())
}

async fn create_section(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (name, effects) = with_docs!(app, headers, |docs| docs.create_section(&project, &body_of(&body)).await?);
    Ok(reply(StatusCode::CREATED, Some(json!({"name": name})), effects))
}

async fn patch_section(State(app): Shared, Path((project, section)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (name, effects) = with_docs!(app, headers, |docs| docs.update_section(&project, &section, &body_of(&body)).await?);
    Ok(reply(StatusCode::OK, Some(json!({"name": name})), effects))
}

async fn delete_section(State(app): Shared, Path((project, section)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let ((), effects) = with_docs!(app, headers, |docs| docs.delete_section(&project, &section).await?);
    Ok(reply(StatusCode::NO_CONTENT, None, effects))
}

#[cfg(test)]
#[path = "docs_tests.rs"]
mod tests;
