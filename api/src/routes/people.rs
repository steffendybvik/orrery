// People, invites, keys and logins: the handlers and the routes they answer (ORR-1048).
use crate::access::people::{holder_of, People};
use crate::changes::Outbox;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, header, login_of, ways_of, who_of};
use crate::routes::auth::login_cookie;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/owner", get(owner).put(name_owner))
        .route("/api/me", get(me).delete(delete_me))
        .route("/api/people", get(list_people).post(add_person))
        .route("/api/people/{person}", patch(rename_person).delete(remove_person))
        .route("/api/invites", post(invite))
        .route("/api/keys", get(list_keys).post(make_key))
        .route("/api/keys/{key}", delete(revoke_key))
        .route("/api/logins", get(list_logins).delete(end_other_logins))
        .route("/api/logins/{login}", delete(end_login))
        .route("/api/projects/{project}/members", get(list_members).post(add_member))
        .route("/api/projects/{project}/members/{person}", delete(remove_member))
}

/// `GET /api/projects/:project/members` → who's on the board, its holder first (ORR-1036).
async fn list_members(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(People::new(&mut conn).members(&project).await?).into_response())
}

/// `POST /api/projects/:project/members` {person} → 201 them on the board: its holder's to do, or the owner's.
async fn add_member(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    people.outbox = Some(Outbox::new(actor_of(&headers)));
    let added = people.add_member(&project, &body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::CREATED, Some(added), std::mem::take(&mut people.effects)))
}

/// `DELETE /api/projects/:project/members/:person` → 204: off the board, as adding does. Its holder stays (400).
async fn remove_member(State(app): Shared, Path((project, person)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    people.outbox = Some(Outbox::new(actor_of(&headers)));
    people.remove_member(&project, &person, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut people.effects)))
}

/// `GET /api/owner` → {name, display, named} (ORR-1036).
async fn owner(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(People::new(&mut conn).owner().await?).into_response())
}

/// `PUT /api/owner` {name} → the owner, named: anyone the first time, then only the owner (ORR-1036).
async fn name_owner(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    people.outbox = Some(Outbox::new(actor_of(&headers)));
    let owner = people.name_owner(&body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::OK, Some(owner), std::mem::take(&mut people.effects)))
}

/// Everyone, to the owner; to anyone else, the people who share a workspace with them (ORR-1195).
async fn list_people(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn).people().await?;
    let who = who_of(&headers);
    if let Some(who) = who.filter(|w| !w.owner) {
        let rows = sqlx::query(crate::db::sql(
            "SELECT DISTINCT o.person FROM workspace_members o JOIN workspace_members m ON m.workspace = o.workspace WHERE m.person = ?",
        ))
        .bind(&who.person)
        .fetch_all(&mut *conn)
        .await?;
        let shared: std::collections::HashSet<String> = rows.iter().map(|r| sqlx::Row::get::<String, _>(r, "person")).collect();
        if let serde_json::Value::Array(list) = &mut people {
            list.retain(|p| p["id"].as_str().is_some_and(|id| shared.contains(id) || id == who.person));
        }
    }
    Ok(Json(people).into_response())
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

/// The person a request is from, signed in through a browser: `GET /api/me` and `DELETE /api/me` are theirs alone,
/// never an agent key's, a session's or the chat's, and with login off there's nobody to be (ORR-1203).
pub(crate) fn signed_in(headers: &HeaderMap) -> Result<String> {
    let actor = actor_of(headers);
    match who_of(headers) {
        Some(who) if who.browser && !actor.chat && !actor.untrusted && actor.session.is_none() => Ok(who.person),
        Some(_) => Err(ApiError::forbidden("Only a person signed in through a browser has an account here, never a session or an agent key")),
        None => Err(ApiError::unauthorized("Sign in to see your account")),
    }
}

/// `GET /api/me` → the signed-in person's account (`People::me`).
async fn me(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let person = signed_in(&headers)?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(People::new(&mut conn).me(&person).await?).into_response())
}

/// `DELETE /api/me` {confirm} → 204: deletes the signed-in person's own account (`People::delete_account`), and ends
/// this browser's login, its cookie cleared as logging out clears it.
async fn delete_me(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let person = signed_in(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    people.outbox = Some(Outbox::new(actor_of(&headers)));
    people.delete_account(&person, &body_of(&body), &actor_of(&headers)).await?;
    let mut response = reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut people.effects));
    let cookie = HeaderValue::from_str(&format!("{}=; Max-Age=0; Path=/", login_cookie(&headers))).map_err(|_| ApiError::internal("a login cookie"))?;
    response.headers_mut().append(axum::http::header::SET_COOKIE, cookie);
    Ok(response)
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

#[cfg(test)]
#[path = "people_tests.rs"]
mod tests;
