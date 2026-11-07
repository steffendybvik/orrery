// People, invites, keys and logins: the handlers and the routes they answer (ORR-1048).
use crate::access::people::{holder_of, People};
use crate::changes::Outbox;
use crate::error::Result;
use crate::reply::reply;
use crate::request::{actor_of, body_of, header, login_of, ways_of, who_of};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/people", get(list_people).post(add_person))
        .route("/api/people/{person}", patch(rename_person).delete(remove_person))
        .route("/api/invites", post(invite))
        .route("/api/keys", get(list_keys).post(make_key))
        .route("/api/keys/{key}", delete(revoke_key))
        .route("/api/logins", get(list_logins).delete(end_other_logins))
        .route("/api/logins/{login}", delete(end_login))
}

async fn list_people(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(People::new(&mut conn).people().await?).into_response())
}

async fn add_person(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let person = People::new(&mut conn).add_person(&body_of(&body), &actor_of(&headers), who_of(&headers).as_ref(), &ways_of(&headers)).await?;
    Ok((StatusCode::CREATED, Json(person)).into_response())
}

async fn remove_person(State(app): Shared, Path(person): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    people.outbox = Some(Outbox::new(actor_of(&headers)));
    people.remove_person(&person, &actor_of(&headers), who_of(&headers).as_ref()).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut people.effects)))
}

async fn rename_person(State(app): Shared, Path(person): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(People::new(&mut conn).rename_person(&person, &body_of(&body), &actor_of(&headers), who_of(&headers).as_ref()).await?).into_response())
}

async fn invite(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let origin = header(&headers, "orrery-origin").unwrap_or_default();
    let mut conn = app.pool.acquire().await?;
    let invite = People::new(&mut conn).invite(&body_of(&body), &actor_of(&headers), who_of(&headers).as_ref(), &ways_of(&headers), &origin).await?;
    Ok((StatusCode::CREATED, Json(invite)).into_response())
}

async fn list_keys(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let (person, owner) = holder_of("keys.write", who_of(&headers).as_ref(), &actor_of(&headers))?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(People::new(&mut conn).keys((!owner).then_some(person.as_str())).await?).into_response())
}

async fn make_key(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (person, owner) = holder_of("keys.write", who_of(&headers).as_ref(), &actor_of(&headers))?;
    let mut conn = app.pool.acquire().await?;
    let key = People::new(&mut conn).make_key(&body_of(&body), &person, owner).await?;
    Ok((StatusCode::CREATED, Json(key)).into_response())
}

async fn revoke_key(State(app): Shared, Path(key): Path<String>, headers: HeaderMap) -> Result<Response> {
    let (person, owner) = holder_of("keys.write", who_of(&headers).as_ref(), &actor_of(&headers))?;
    let mut conn = app.pool.acquire().await?;
    People::new(&mut conn).revoke_key(&key, (!owner).then_some(person.as_str())).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn list_logins(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let (person, owner) = holder_of("logins.write", who_of(&headers).as_ref(), &actor_of(&headers))?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(People::new(&mut conn).logins((!owner).then_some(person.as_str()), login_of(&headers).as_deref()).await?).into_response())
}

async fn end_other_logins(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let (person, owner) = holder_of("logins.write", who_of(&headers).as_ref(), &actor_of(&headers))?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(People::new(&mut conn).end_other_logins((!owner).then_some(person.as_str()), login_of(&headers).as_deref()).await?).into_response())
}

async fn end_login(State(app): Shared, Path(login): Path<String>, headers: HeaderMap) -> Result<Response> {
    let (person, owner) = holder_of("logins.write", who_of(&headers).as_ref(), &actor_of(&headers))?;
    let mut conn = app.pool.acquire().await?;
    People::new(&mut conn).end_login(&login, (!owner).then_some(person.as_str())).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
