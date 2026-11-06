// orrery's API in Rust (ORR-922). For now it serves docs, the statuses (ORR-926), milestones and releases (ORR-926, written in ORR-974), reading issues, their comments, their activity and the images uploaded to them (ORR-927), people, invites, keys and logins (ORR-928), presets (ORR-949), reading the secrets, never a value (ORR-953), the settings (ORR-954) reading one pull request as orrery keeps it and rating its risk (ORR-952), on the database the Nuxt server opens, and only
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
mod chats;
mod comments;
mod db;
mod docs;
mod error;
mod issue_edits;
mod issues;
mod migrate;
mod milestones;
mod people;
mod plans;
mod presets;
mod pull_poll;
mod pulls;
mod releases;
mod schedules;
mod secrets;
mod settings;
mod statuses;
mod steps;
mod text;
mod uploads;

use axum::body::Bytes;
use axum::extract::{Path, Query, Request, State};
use axum::http::header::ACCEPT;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use changes::Outbox;
use chats::Chats;
use comments::{comment_id, Comments, Handoff};
use docs::{Actor, Docs, Effects};
use error::{ApiError, Result};
use issues::Issues;
use milestones::Milestones;
use people::{holder_of, People, Ways, Who};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use plans::Plans;
use presets::{preset_id, Presets};
use pull_poll::PullPoll;
use pulls::{check_rating, pull_number, Pulls};
use releases::Releases;
use schedules::Schedules;
use secrets::Secrets;
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
    let kind = header(headers, "orrery-actor-kind");
    Actor {
        name: header(headers, "orrery-actor-name").filter(|n| !n.is_empty()).unwrap_or_else(|| "agent".into()),
        owner: header(headers, "orrery-actor-owner").as_deref() == Some("1"),
        session: header(headers, "orrery-actor-session").filter(|s| !s.is_empty()),
        person: header(headers, "orrery-actor-person").filter(|p| !p.is_empty()),
        named: header(headers, "orrery-actor-named").filter(|n| !n.is_empty()),
        asked: header(headers, "orrery-actor-asked").as_deref() == Some("1"),
        untrusted: kind.as_deref() == Some("untrusted"),
        chat: kind.as_deref() == Some("chat"),
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

/// One event as `Orrery-Told` says it: `<type> <project> <subject>`, then `<from> <to>` when a value changed, `~` for
/// one that's none (an encoded value is never a bare `~`).
fn told_of(told: &docs::Told, encode: &impl Fn(&str) -> String) -> String {
    let mut said = format!("{} {} {}", encode(&told.kind), encode(&told.project), encode(&told.subject));
    if told.from.is_some() || told.to.is_some() {
        let part = |v: &Option<String>| v.as_deref().map(encode).unwrap_or_else(|| "~".into());
        said = format!("{said} {} {}", part(&told.from), part(&told.to));
    }
    said
}

/// A write's reply, with what it changed for the router to tell: `Orrery-Changed: <project>, …`, `Orrery-Settings: 1`
/// when the orrery's settings changed (the statuses are in them), and `Orrery-Told: <type> <project> <subject>, …`, each
/// part percent-encoded.
fn reply(status: StatusCode, body: Option<Value>, effects: Effects) -> Response {
    // The write is committed by now, with its outbox rows: the open streams can send them (ORR-929).
    if !effects.changed.is_empty() || effects.settings || !effects.told.is_empty() {
        changes::wake();
    }
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
        let told = effects.told.iter().map(|t| told_of(t, &encode)).collect::<Vec<_>>().join(", ");
        response.headers_mut().insert("orrery-told", HeaderValue::from_str(&told).unwrap());
    }
    response
}

/// `GET /api/changes?after=<id>`: a page of the outbox as JSON, or, asked with `Accept: text/event-stream`, the rows as
/// server-sent events, oldest first, then live. A reconnecting stream's `Last-Event-ID` stands for `after`.
async fn list_changes(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let streamed = headers.get(ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/event-stream"));
    if streamed {
        let after = changes::cursor(header(&headers, "last-event-id").or_else(|| query.get("after").cloned()).as_deref())?;
        return Ok(Sse::new(changes::stream(app.pool.clone(), after)).keep_alive(KeepAlive::default()).into_response());
    }
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

/// `POST …/issues/{issue}/comments`: the new comment, and in `Orrery-Carry` and `Orrery-Notice` (`<project> <issue>
/// <comment>`, each part percent-encoded) what the router passes on to the session on the issue and the owner's bell.
async fn create_comment(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = Comments::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    let (value, handoff) = comments.create(&project, &issue, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut comments.effects);
    let mut response = reply(StatusCode::CREATED, Some(value), effects);
    for (header, said) in handoff_headers(&handoff) {
        response.headers_mut().insert(header, HeaderValue::from_str(&said).unwrap());
    }
    Ok(response)
}

/// The headers a new comment's `Handoff` is said in.
fn handoff_headers(handoff: &Handoff) -> Vec<(&'static str, String)> {
    let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    let edited = if handoff.edited { " edited" } else { "" };
    let said = format!("{} {} {}{edited}", encode(&handoff.project), encode(&handoff.issue), handoff.comment);
    [("orrery-carry", handoff.carry), ("orrery-notice", handoff.notice)].into_iter().filter(|(_, on)| *on).map(|(h, _)| (h, said.clone())).collect()
}

/// `PATCH …/issues/{issue}/comments/{comment}`: the comment, and in `Orrery-Carry` (`<project> <issue> <comment>
/// edited`) the new words for the router to pass on to the session on the issue, when they're its person's own.
async fn patch_comment(
    State(app): Shared,
    Path((project, issue, comment)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    let id = comment_id(&comment)?;
    let mut conn = app.pool.acquire().await?;
    let mut comments = Comments::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    let (value, handoff) = comments.update(&project, &issue, id, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut comments.effects);
    let mut response = reply(StatusCode::OK, Some(value), effects);
    for (header, said) in handoff.as_ref().map(handoff_headers).unwrap_or_default() {
        response.headers_mut().insert(header, HeaderValue::from_str(&said).unwrap());
    }
    Ok(response)
}

async fn delete_comment(State(app): Shared, Path((project, issue, comment)): Path<(String, String, String)>, headers: HeaderMap) -> Result<Response> {
    let id = comment_id(&comment)?;
    let mut conn = app.pool.acquire().await?;
    let mut comments = Comments::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    comments.delete(&project, &issue, id, &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut comments.effects);
    Ok(reply(StatusCode::NO_CONTENT, None, effects))
}

/// `POST …/issues/{issue}/claim`: the issue, taken up by whoever's asking (`claimIssue`, ORR-657).
async fn claim_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    claim_or_release(app, project, issue, headers, true).await
}

/// `DELETE …/issues/{issue}/claim`: the issue, let go (`releaseIssue`). It stays assigned.
async fn release_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    claim_or_release(app, project, issue, headers, false).await
}

/// `PATCH …/issues/{issue}` with only an issue's own words (`issue_edits::WORDS`): the issue (`updateIssue`).
async fn patch_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = Comments::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    comments.edit_words(&project, &issue, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut comments.effects);
    let value = Issues::new(&mut conn).issue(&project, &issue).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

/// `DELETE …/issues/{issue}`: 204, its sub-issues and comments gone with it (`deleteIssue`).
async fn delete_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = Comments::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    comments.delete_issue(&project, &issue, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut comments.effects)))
}

async fn claim_or_release(app: Arc<App>, project: String, issue: String, headers: HeaderMap, claim: bool) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = Comments::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    let actor = actor_of(&headers);
    let id = if claim { comments.claim(&project, &issue, &actor).await? } else { comments.release(&project, &issue, &actor).await? };
    let effects = std::mem::take(&mut comments.effects);
    let value = Issues::new(&mut conn).issue(&project, &id).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
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

async fn create_milestone(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut milestones = Milestones::new(&mut conn);
    milestones.outbox = Some(Outbox::new(actor_of(&headers)));
    let id = milestones.create(&project, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut milestones.effects);
    let value = Plans::new(&mut Issues::new(&mut conn)).milestone(&project, &id).await?;
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn patch_milestone(State(app): Shared, Path((project, milestone)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut milestones = Milestones::new(&mut conn);
    milestones.outbox = Some(Outbox::new(actor_of(&headers)));
    let id = milestones.update(&project, &milestone, &body_of(&body)).await?;
    let effects = std::mem::take(&mut milestones.effects);
    let value = Plans::new(&mut Issues::new(&mut conn)).milestone(&project, &id).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn delete_milestone(State(app): Shared, Path((project, milestone)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut milestones = Milestones::new(&mut conn);
    milestones.outbox = Some(Outbox::new(actor_of(&headers)));
    milestones.delete(&project, &milestone, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut milestones.effects)))
}

async fn create_release(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut releases = Releases::new(&mut conn);
    releases.outbox = Some(Outbox::new(actor_of(&headers)));
    let version = releases.create(&project, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut releases.effects);
    let value = Plans::new(&mut Issues::new(&mut conn)).release(&project, &version).await?;
    Ok(reply(StatusCode::CREATED, Some(value), effects))
}

async fn patch_release(State(app): Shared, Path((project, release)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut releases = Releases::new(&mut conn);
    releases.outbox = Some(Outbox::new(actor_of(&headers)));
    releases.update(&project, &release, &body_of(&body)).await?;
    let effects = std::mem::take(&mut releases.effects);
    let value = Plans::new(&mut Issues::new(&mut conn)).release(&project, &release).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn delete_release(State(app): Shared, Path((project, release)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut releases = Releases::new(&mut conn);
    releases.outbox = Some(Outbox::new(actor_of(&headers)));
    releases.delete(&project, &release, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut releases.effects)))
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
    // A write: what it sets off goes into the outbox inside its transaction (ORR-929).
    ($app:expr, $headers:expr, |$statuses:ident| $work:expr) => {{
        let mut conn = $app.pool.acquire().await?;
        let mut $statuses = Statuses::new(&mut *conn);
        $statuses.outbox = Some(Outbox::new(actor_of(&$headers)));
        let value = $work;
        (value, std::mem::take(&mut $statuses.effects))
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
    // What it sets off goes into the outbox inside its transaction (ORR-929).
    settings.outbox = Some(Outbox::new(actor_of(&headers)));
    let value = settings.update(&body_of(&body), &actor_of(&headers)).await?;
    Ok(reply(StatusCode::OK, Some(value), std::mem::take(&mut settings.effects)))
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

async fn get_upload(State(app): Shared, Path(upload): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    uploads::upload(&mut conn, &upload).await
}

async fn list_secrets(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Secrets::new(&mut conn).list().await?).into_response())
}

async fn get_secret(State(app): Shared, Path(name): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Secrets::new(&mut conn).secret(&name).await?).into_response())
}

/// Whether the owner is asking, as `kindOf` has it: the router's `Orrery-Actor-Kind`, so the chat and an untrusted
/// session aren't, whoever they name; the actor's own word without it.
fn owner_asking(headers: &HeaderMap) -> bool {
    match header(headers, "orrery-actor-kind") {
        Some(kind) => kind == "owner",
        None => actor_of(headers).owner,
    }
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

async fn all_schedules(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Schedules::new(&mut conn).list(None).await?).into_response())
}

async fn list_schedules(State(app): Shared, Path(project): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Schedules::new(&mut conn).list(Some(&project)).await?).into_response())
}

async fn get_schedule(State(app): Shared, Path((project, schedule)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    Ok(Json(Schedules::new(&mut conn).get(&project, &schedule, &uid).await?).into_response())
}

async fn schedules_across(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Schedules::new(&mut conn).across().await?).into_response())
}

async fn list_chats(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Chats::new(&mut conn).list().await?).into_response())
}

async fn keep_chat(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    chats.keep(&chat, &body_of(&body)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut chats.effects)))
}

async fn forget_chat(State(app): Shared, Path(chat): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut chats = Chats::new(&mut conn);
    chats.outbox = Some(Outbox::new(actor_of(&headers)));
    chats.forget(&chat).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut chats.effects)))
}

async fn get_chat(State(app): Shared, Path(chat): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Chats::new(&mut conn).get(&chat).await?).into_response())
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
        json!({"ok": true, "domains": ["docs", "statuses", "issues, reading", "comments, reading", "activity", "claims", "an issue, deleted", "an issue, its words", "milestones", "releases", "people", "invites", "keys", "logins", "uploads, reading", "presets", "secrets, reading", "settings", "a pull request, reading", "a pull request's risk", "schedules, reading"]}),
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
        .route(&format!("{P}/issues/{{issue}}"), get(get_issue).patch(patch_issue).delete(delete_issue))
        .route(&format!("{P}/issues/{{issue}}/claim"), post(claim_issue).delete(release_issue))
        .route(&format!("{P}/issues/{{issue}}/comments"), get(list_comments).post(create_comment))
        .route(&format!("{P}/issues/{{issue}}/comments/{{comment}}"), get(get_comment).patch(patch_comment).delete(delete_comment))
        .route(&format!("{P}/issues/{{issue}}/activity"), get(get_activity))
        .route(&format!("{P}/milestones"), get(list_milestones).post(create_milestone))
        .route(&format!("{P}/milestones/{{milestone}}"), get(get_milestone).patch(patch_milestone).delete(delete_milestone))
        .route(&format!("{P}/releases"), get(list_releases).post(create_release))
        .route(&format!("{P}/releases/{{release}}"), get(get_release).patch(patch_release).delete(delete_release))
        .route("/api/releases", get(all_releases))
        .route("/api/uploads/{upload}", get(get_upload))
        .route("/api/changes", get(list_changes))
        .route("/api/statuses", get(list_statuses).post(create_status))
        .route("/api/statuses/{status}", patch(patch_status).delete(delete_status))
        .route("/api/settings", get(get_settings).patch(patch_settings))
        .route("/api/people", get(list_people).post(add_person))
        .route("/api/people/{person}", patch(rename_person).delete(remove_person))
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
        .route("/api/secrets", get(list_secrets))
        .route("/api/secrets/{name}", get(get_secret))
        .route("/api/pulls/{owner}/{name}/{number}", get(get_pull).put(keep_pull))
        .route("/api/pulls/{owner}/{name}", put(polled_repo))
        .route("/api/pulls/{owner}/{name}/error", put(polled_repo_failed))
        .route("/api/pulls/{owner}/{name}/history", put(polled_repo_history))
        .route("/api/pulls/forget", post(forget_pulls))
        .route(&format!("{P}/issues/{{issue}}/pulls/{{owner}}/{{name}}/{{number}}/risk"), put(rate_pull))
        .route(&format!("{P}/schedules"), get(list_schedules))
        .route(&format!("{P}/schedules/{{schedule}}"), get(get_schedule))
        .route("/api/schedules", get(all_schedules))
        .route("/api/chats", get(list_chats))
        .route("/api/chats/{chat}", get(get_chat).put(keep_chat).delete(forget_chat))
        .route("/api/schedules/across", get(schedules_across))
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
    // The outbox keeps a week (ORR-929): pruned now, then hourly.
    let pruning = pool.clone();
    tokio::spawn(async move {
        loop {
            changes::prune(&pruning).await.ok();
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actor_of_reads_the_rails_fields() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("orrery-actor-name", "Ana%20Lu"),
            ("orrery-actor-owner", "0"),
            ("orrery-actor-kind", "untrusted"),
            ("orrery-actor-person", "ana"),
            ("orrery-actor-named", "Ana"),
            ("orrery-actor-asked", "1"),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
        let actor = actor_of(&headers);
        assert_eq!((actor.name.as_str(), actor.owner, actor.person.as_deref(), actor.named.as_deref()), ("Ana Lu", false, Some("ana"), Some("Ana")));
        assert!(actor.asked && actor.untrusted && !actor.chat);
        let bare = actor_of(&HeaderMap::new());
        assert_eq!((bare.name.as_str(), bare.person, bare.named, bare.asked, bare.untrusted, bare.chat), ("agent", None, None, false, false, false));
    }
}
