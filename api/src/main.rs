// orrery's API in Rust (ORR-922). For now it serves docs, the statuses (ORR-926), reading milestones and releases (ORR-926), reading issues, their comments, their activity and the images uploaded to them (ORR-927), people, invites, keys and logins (ORR-928), presets (ORR-949) and the settings (ORR-954), on the database the Nuxt server opens, and only
// to that server: the router there (web/server/middleware/zz-api.ts) checks a request as it always has (auth, the
// board's permissions, the chat's and untrusted sessions' rails, the browser guards) and then forwards it here with
// who it's from. So this listens on loopback, and answers only a request that carries the token they share.
//
//   NUXT_API_TOKEN     the token they share, as the Nuxt server's setting of that name; required
//   NUXT_DATABASE      the database, as the Nuxt server's setting names it: a SQLite file or a postgres:// URL
//   ORRERY_API_LISTEN  where to listen; 127.0.0.1:9100 by default
//   ORRERY_API_SCHEMA  on Postgres, the schema to work in (the tests' own)
//   ORRERY_API_LOG     1: says each request it answers, and how
//
// `orrery-api migrate` brings NUXT_DATABASE's schema up to date instead (ORR-931), and exits. Nothing runs it yet: the
// Nuxt server migrates the database as it opens it until the last domain has moved here.
mod changes;
mod comments;
mod db;
mod docs;
mod error;
mod issues;
mod migrate;
mod people;
mod plans;
mod presets;
mod settings;
mod statuses;
mod steps;
mod text;
mod uploads;

use axum::body::Bytes;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use comments::{comment_id, Comments};
use docs::{Actor, Docs, Effects};
use error::{ApiError, Result};
use issues::Issues;
use people::{holder_of, People, Ways, Who};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use plans::Plans;
use presets::{preset_id, Presets};
use serde_json::{json, Value};
use settings::Settings;
use sha2::{Digest, Sha256};
use sqlx::AnyPool;
use statuses::Statuses;
use std::collections::HashMap;
use std::sync::Arc;

struct App {
    pool: AnyPool,
    token: String,
    /// The database's setting, hashed: what the router sends, so a request for another database (the owner moved it in
    /// App settings, and this API wasn't restarted) is turned back rather than written to the old one.
    database: String,
    log: bool,
}

type Shared = State<Arc<App>>;

fn database_hash(setting: &str) -> String {
    Sha256::digest(setting.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(name)?.to_str().ok()?;
    Some(percent_decode_str(raw).decode_utf8_lossy().into_owned())
}

/// Who the router says the request is from. It sends the name and session percent-encoded, as a header holds only ASCII.
fn actor_of(headers: &HeaderMap) -> Actor {
    Actor {
        name: header(headers, "orrery-actor-name").filter(|n| !n.is_empty()).unwrap_or_else(|| "agent".into()),
        owner: header(headers, "orrery-actor-owner").as_deref() == Some("1"),
        session: header(headers, "orrery-actor-session").filter(|s| !s.is_empty()),
    }
}

/// The credential the router checked, if auth is on (`Who`): `Orrery-Who: browser|agent`, with its person and whether
/// they're the owner.
fn who_of(headers: &HeaderMap) -> Option<Who> {
    let browser = match header(headers, "orrery-who").as_deref() {
        Some("browser") => true,
        Some("agent") => false,
        _ => return None,
    };
    let person = header(headers, "orrery-who-person").filter(|p| !p.is_empty())?;
    Some(Who { person, owner: header(headers, "orrery-who-owner").as_deref() == Some("1"), browser })
}

/// What the router's settings say about getting in: `Orrery-Login-Ways: provider, off`, either or both.
fn ways_of(headers: &HeaderMap) -> Ways {
    let said = header(headers, "orrery-login-ways").unwrap_or_default();
    let has = |way: &str| said.split(',').any(|w| w.trim() == way);
    Ways { provider: has("provider"), off: has("off") }
}

/// The asking browser's login, hashed as the logins table keeps it: the cookie itself stays with the router.
fn login_of(headers: &HeaderMap) -> Option<String> {
    header(headers, "orrery-login").filter(|l| !l.is_empty())
}

async fn guard(State(app): Shared, request: Request, next: Next) -> Response {
    if request.uri().path() == "/health" {
        return next.run(request).await;
    }
    let headers = request.headers();
    let token = headers.get("orrery-api-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    // Compared in full whatever it holds, so how long the reply takes says nothing of the token.
    let same = token.len() == app.token.len() && token.bytes().zip(app.token.bytes()).fold(0, |d, (a, b)| d | (a ^ b)) == 0;
    if !same {
        return ApiError::unauthorized("This API answers the orrery server in front of it, which sends its token").into_response();
    }
    if headers.get("orrery-database").and_then(|v| v.to_str().ok()) != Some(app.database.as_str()) {
        return ApiError::misdirected("This API is on another database than the one asked for").into_response();
    }
    let said = app.log.then(|| format!("{} {}", request.method(), request.uri()));
    let response = next.run(request).await;
    if let Some(said) = said {
        eprintln!("[orrery-api] {said} {}", response.status().as_u16());
    }
    response
}

fn body_of(bytes: &Bytes) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).unwrap_or(Value::Null)
    }
}

/// A write's reply, with what it changed for the router to tell: `Orrery-Changed: <project>, …`, `Orrery-Settings: 1`
/// when the orrery's settings changed (the statuses are in them), and `Orrery-Told: <type> <project> <subject>, …`, each
/// part percent-encoded.
fn reply(status: StatusCode, body: Option<Value>, effects: Effects) -> Response {
    let mut response = match body {
        Some(body) => (status, Json(body)).into_response(),
        None => status.into_response(),
    };
    let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    if !effects.changed.is_empty() {
        let changed = effects.changed.iter().map(|p| encode(p)).collect::<Vec<_>>().join(", ");
        response.headers_mut().insert("orrery-changed", HeaderValue::from_str(&changed).unwrap());
    }
    if effects.settings {
        response.headers_mut().insert("orrery-settings", HeaderValue::from_static("1"));
    }
    if !effects.settings_keys.is_empty() {
        let keys = effects.settings_keys.iter().map(|k| encode(k)).collect::<Vec<_>>().join(", ");
        response.headers_mut().insert("orrery-settings-keys", HeaderValue::from_str(&keys).unwrap());
    }
    if !effects.told.is_empty() {
        let told = effects.told.iter().map(|(t, p, s)| format!("{} {} {}", encode(t), encode(p), encode(s))).collect::<Vec<_>>().join(", ");
        response.headers_mut().insert("orrery-told", HeaderValue::from_str(&told).unwrap());
    }
    response
}

async fn list_changes(State(app): Shared, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(changes::after(&mut conn, query.get("after").map(String::as_str)).await?).into_response())
}

/// Runs `work` with the docs on a connection of the pool's: what it gives back, and what it changed.
macro_rules! with_docs {
    ($app:expr, |$docs:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let mut $docs = Docs::new(&mut *conn);
        let value = $work;
        (value, std::mem::take(&mut $docs.effects))
    }};
    // A write: what it set off goes into the outbox on its own connection (ORR-929).
    ($app:expr, $headers:expr, |$docs:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let mut $docs = Docs::new(&mut *conn);
        let value = $work;
        let effects = std::mem::take(&mut $docs.effects);
        changes::record(&mut conn, &effects, &actor_of(&$headers)).await?;
        (value, effects)
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

async fn list_issues(State(app): Shared, Path(project): Path<String>, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Issues::new(&mut conn).list(&project, &query).await?).into_response())
}

async fn get_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Issues::new(&mut conn).issue(&project, &issue).await?).into_response())
}

async fn list_comments(State(app): Shared, Path((project, issue)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Comments::new(&mut conn).list(&project, &issue).await?).into_response())
}

async fn get_activity(State(app): Shared, Path((project, issue)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Comments::new(&mut conn).activity(&project, &issue).await?).into_response())
}

async fn get_comment(State(app): Shared, Path((project, issue, comment)): Path<(String, String, String)>) -> Result<Response> {
    let id = comment_id(&comment)?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Comments::new(&mut conn).comment(&project, &issue, id).await?).into_response())
}

async fn list_milestones(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).milestones(&project).await?).into_response())
}

async fn get_milestone(State(app): Shared, Path((project, milestone)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).milestone(&project, &milestone).await?).into_response())
}

async fn list_releases(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).releases(&project).await?).into_response())
}

async fn get_release(State(app): Shared, Path((project, release)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).release(&project, &release).await?).into_response())
}

async fn all_releases(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Plans::new(&mut Issues::new(&mut conn)).all_releases().await?).into_response())
}

/// Runs `work` with the statuses on a connection of the pool's, as `with_docs` does with the docs.
macro_rules! with_statuses {
    ($app:expr, |$statuses:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let mut $statuses = Statuses::new(&mut *conn);
        let value = $work;
        (value, std::mem::take(&mut $statuses.effects))
    }};
    // A write: what it set off goes into the outbox on its own connection (ORR-929).
    ($app:expr, $headers:expr, |$statuses:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let mut $statuses = Statuses::new(&mut *conn);
        let value = $work;
        let effects = std::mem::take(&mut $statuses.effects);
        changes::record(&mut conn, &effects, &actor_of(&$headers)).await?;
        (value, effects)
    }};
}

async fn list_statuses(State(app): Shared) -> Result<Response> {
    let (value, _) = with_statuses!(app, |statuses| statuses.list().await?);
    Ok(Json(value).into_response())
}

async fn create_status(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (value, effects) = with_statuses!(app, headers, |statuses| statuses.create(&body_of(&body), &actor_of(&headers)).await?);
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn patch_status(State(app): Shared, Path(status): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let (value, effects) = with_statuses!(app, headers, |statuses| statuses.update(&status, &body_of(&body), &actor_of(&headers)).await?);
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn delete_status(State(app): Shared, Path(status): Path<String>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap) -> Result<Response> {
    let into = query.get("into").map(String::as_str).filter(|s| !s.is_empty());
    let ((), effects) = with_statuses!(app, headers, |statuses| statuses.delete(&status, into, &actor_of(&headers)).await?);
    Ok(reply(StatusCode::NO_CONTENT, None, effects))
}

async fn get_settings(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Settings::new(&mut conn).get().await?).into_response())
}

async fn patch_settings(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut settings = Settings::new(&mut conn);
    let value = settings.update(&body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut settings.effects);
    // What it set off goes into the outbox on its own connection (ORR-929).
    changes::record(&mut conn, &effects, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
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

async fn get_upload(State(app): Shared, Path(upload): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    uploads::upload(&mut conn, &upload).await
}

async fn list_presets(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Presets::new(&mut conn).list(None).await?).into_response())
}

async fn list_project_presets(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Presets::new(&mut conn).list(Some(&project)).await?).into_response())
}

async fn create_preset(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let preset = Presets::new(&mut conn).create(None, &body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::CREATED, Some(preset), Effects::default()))
}

async fn create_project_preset(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let preset = Presets::new(&mut conn).create(Some(&project), &body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::CREATED, Some(preset), Effects::default()))
}

/// The preset the URL names, by its number or its full id on this server.
async fn preset_named(presets: &mut Presets<'_>, sent: &str) -> Result<i64> {
    let uid = presets.uid().await?;
    preset_id(sent, &uid)
}

async fn patch_preset(State(app): Shared, Path(preset): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut presets = Presets::new(&mut conn);
    let id = preset_named(&mut presets, &preset).await?;
    Ok(Json(presets.update(id, &body_of(&body), &actor_of(&headers)).await?).into_response())
}

async fn delete_preset(State(app): Shared, Path(preset): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut presets = Presets::new(&mut conn);
    let id = preset_named(&mut presets, &preset).await?;
    presets.delete(id, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, Effects::default()))
}

async fn reset_preset(State(app): Shared, Path(preset): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut presets = Presets::new(&mut conn);
    let id = preset_named(&mut presets, &preset).await?;
    Ok(Json(presets.reset(id, &actor_of(&headers)).await?).into_response())
}

async fn restore_presets(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Presets::new(&mut conn).restore(&actor_of(&headers)).await?).into_response())
}

async fn health() -> Json<Value> {
    Json(
        json!({"ok": true, "domains": ["docs", "statuses", "issues, reading", "comments, reading", "activity", "milestones and releases, reading", "people, but removing one", "invites", "keys", "logins", "uploads, reading", "presets", "settings"]}),
    )
}

fn router(app: Arc<App>) -> Router {
    const P: &str = "/api/projects/{project}";
    Router::new()
        .route("/health", get(health))
        .route(&format!("{P}/docs"), get(list_docs).post(create_doc))
        .route(&format!("{P}/docs/{{doc}}"), get(get_doc).put(put_doc).patch(patch_doc).delete(delete_doc))
        .route(&format!("{P}/docs/{{doc}}/revisions"), get(list_revisions))
        .route(&format!("{P}/docs/{{doc}}/revisions/{{revision}}"), get(get_revision))
        .route(&format!("{P}/docs/{{doc}}/revisions/{{revision}}/restore"), post(restore_revision))
        .route(&format!("{P}/deleted-docs"), get(deleted_docs))
        .route(&format!("{P}/doc-sections"), get(list_sections).post(create_section))
        .route(&format!("{P}/doc-sections/{{section}}"), patch(patch_section).delete(delete_section))
        .route(&format!("{P}/issues"), get(list_issues))
        .route(&format!("{P}/issues/{{issue}}"), get(get_issue))
        .route(&format!("{P}/issues/{{issue}}/comments"), get(list_comments))
        .route(&format!("{P}/issues/{{issue}}/comments/{{comment}}"), get(get_comment))
        .route(&format!("{P}/issues/{{issue}}/activity"), get(get_activity))
        .route(&format!("{P}/milestones"), get(list_milestones))
        .route(&format!("{P}/milestones/{{milestone}}"), get(get_milestone))
        .route(&format!("{P}/releases"), get(list_releases))
        .route(&format!("{P}/releases/{{release}}"), get(get_release))
        .route("/api/releases", get(all_releases))
        .route("/api/uploads/{upload}", get(get_upload))
        .route("/api/changes", get(list_changes))
        .route("/api/statuses", get(list_statuses).post(create_status))
        .route("/api/statuses/{status}", patch(patch_status).delete(delete_status))
        .route("/api/settings", get(get_settings).patch(patch_settings))
        .route("/api/people", get(list_people).post(add_person))
        .route("/api/people/{person}", patch(rename_person))
        .route("/api/invites", post(invite))
        .route("/api/keys", get(list_keys).post(make_key))
        .route("/api/keys/{key}", axum::routing::delete(revoke_key))
        .route("/api/logins", get(list_logins).delete(end_other_logins))
        .route("/api/logins/{login}", axum::routing::delete(end_login))
        .route("/api/presets", get(list_presets).post(create_preset))
        .route("/api/presets/defaults", post(restore_presets))
        .route("/api/presets/{preset}", patch(patch_preset).delete(delete_preset))
        .route("/api/presets/{preset}/reset", post(reset_preset))
        .route(&format!("{P}/presets"), get(list_project_presets).post(create_project_preset))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

#[tokio::main]
async fn main() {
    let fail = |message: String| -> ! {
        eprintln!("[orrery-api] {message}");
        std::process::exit(1)
    };
    if std::env::args().nth(1).as_deref() == Some("migrate") {
        let setting =
            std::env::var("NUXT_DATABASE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| fail("set NUXT_DATABASE to the database to migrate".into()));
        let done = migrate::migrate(&setting, std::env::var("ORRERY_API_SCHEMA").ok().as_deref()).await.unwrap_or_else(|e| fail(e));
        if done.from == done.to {
            eprintln!("[orrery-api] the schema is at step {} already", done.to);
        } else {
            eprintln!("[orrery-api] migrated the schema from step {} to {}", done.from, done.to);
        }
        return;
    }
    let token = std::env::var("NUXT_API_TOKEN")
        .ok()
        .filter(|t| t.len() >= 16)
        .unwrap_or_else(|| fail("set NUXT_API_TOKEN (16 characters or more), the same as the Nuxt server's".into()));
    let setting =
        std::env::var("NUXT_DATABASE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| fail("set NUXT_DATABASE to the database the Nuxt server opens".into()));
    let listen = std::env::var("ORRERY_API_LISTEN").unwrap_or_else(|_| "127.0.0.1:9100".into());
    let pool = db::open(&setting, std::env::var("ORRERY_API_SCHEMA").ok()).await.unwrap_or_else(|e| fail(e));
    // A SQLite file as the Nuxt server names it (`databaseSetting`): its whole path.
    let named = if db::is_postgres(&setting) {
        setting.clone()
    } else {
        std::path::absolute(&setting).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|e| fail(format!("can't place {setting}: {e}")))
    };
    let app = Arc::new(App { pool, token, database: database_hash(&named), log: std::env::var("ORRERY_API_LOG").is_ok_and(|v| v == "1") });
    let listener = tokio::net::TcpListener::bind(&listen).await.unwrap_or_else(|e| fail(format!("can't listen on {listen}: {e}")));
    let at = listener.local_addr().map(|a| a.to_string()).unwrap_or(listen);
    eprintln!("[orrery-api] serving docs on http://{at}, {}", if db::is_postgres(&setting) { "Postgres" } else { "SQLite" });
    axum::serve(listener, router(app))
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await
        .unwrap_or_else(|e| fail(e.to_string()));
}
