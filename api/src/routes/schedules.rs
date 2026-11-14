// Schedules: the handlers and the routes they answer (ORR-1048); of the writes, adopting and deleting one (ORR-950), and
// pausing or activating all of a project's, making and changing one, and deleting one across projects (ORR-1082).
use super::issues::handoff_headers;
use super::P;
use crate::changes::Outbox;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, came_of};
use crate::work::presets::{server_id, Presets};
use crate::work::schedule_requests::ScheduleRequests;
use crate::work::schedule_runs::ScheduleRuns;
use crate::work::schedules::Schedules;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::Value;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(&format!("{P}/schedules"), get(list_schedules).post(create_schedule))
        .route(&format!("{P}/schedules/{{schedule}}"), get(get_schedule).patch(patch_schedule).delete(delete_schedule))
        .route(&format!("{P}/schedules/{{schedule}}/adopt"), post(adopt_schedule))
        .route(&format!("{P}/schedules/enabled"), post(set_all_enabled))
        .route("/api/schedules", get(all_schedules).post(create_across))
        .route("/api/schedules/across", get(schedules_across))
        .route("/api/schedules/across/{across}", delete(delete_across).patch(update_across))
        .route(&format!("{P}/schedules/{{schedule}}/claim"), post(claim_run))
        .route(&format!("{P}/schedules/{{schedule}}/runs"), post(record_run))
        .route("/api/schedules/{schedule}/held", delete(drop_held))
        .route("/api/schedules/{schedule}/held/{subject}", put(hold_event).delete(take_held))
        .route(&format!("{P}/issues/{{issue}}/schedule-requests"), post(ask_schedule))
        .route(&format!("{P}/issues/{{issue}}/schedule-requests/{{comment}}"), post(answer_schedule))
}

/// `POST …/issues/:issue/schedule-requests` {schedule, id?, why?} → 201 the comment asking (ORR-458, ORR-1100): a working
/// session asking the owner, on the issue it's working, to make a schedule or change schedule `id`. The comment waits on
/// their decision with Allow and Deny, which the Nuxt server answers; nothing is saved until they allow it. The router
/// checks the session's claim on the issue first, and the rails who may ask. The comment's hand-on comes back as a new
/// comment's does, and the event log's line as `Orrery-Asked` (`<project> <issue> <schedule or -> <fields> <line>`,
/// each percent-encoded, fields apart by commas), as only the Nuxt server keeps that log.
async fn ask_schedule(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let actor = actor_of(&headers);
    let asked = ScheduleRequests::new(&mut conn).ask(&project, &issue, &body_of(&body), &actor).await?;
    let mut response = reply(StatusCode::CREATED, Some(asked.comment.clone()), asked.effects);
    for (header, said) in handoff_headers(&asked.handoff) {
        response.headers_mut().insert(header, HeaderValue::from_str(&said).unwrap());
    }
    let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    let schedule = asked.request.get("id").and_then(Value::as_i64).map(|id| id.to_string()).unwrap_or_else(|| "-".into());
    let fields = asked.request["body"].as_object().map(|b| b.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default();
    let issue = asked.comment["issue"].as_str().unwrap_or(&issue).to_string();
    let said = format!("{} {} {} {} {}", encode(&project), encode(&issue), schedule, encode(&fields), encode(&asked.line));
    response.headers_mut().insert("orrery-asked", HeaderValue::from_str(&said).unwrap());
    Ok(response)
}

/// A run's writes are the local app's clock's alone (ORR-1176): it runs the schedules, so nothing outside asks for them.
fn clock_only(headers: &HeaderMap) -> Result<()> {
    if came_of(headers).server {
        Ok(())
    } else {
        Err(ApiError::forbidden("Only the local app's clock runs a schedule: run one with POST …/schedules/:schedule/run"))
    }
}

/// The schedule's id as it's sent, a number or its full id.
async fn schedule_id(conn: &mut sqlx::AnyConnection, sent: &str) -> Result<i64> {
    let uid = Presets::new(conn).uid().await?;
    server_id("sch-", "schedule", sent, &uid)
}

/// `POST …/schedules/:schedule/claim` {from, to, enabled} → {claimed}: the clock taking the run due at `from`.
async fn claim_run(State(app): Shared, Path((project, schedule)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    clock_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let id = schedule_id(&mut conn, &schedule).await?;
    let claimed = ScheduleRuns::new(&mut conn).claim(&project, id, &body_of(&body)).await?;
    Ok(Json(serde_json::json!({"claimed": claimed})).into_response())
}

/// `POST …/schedules/:schedule/runs` {at, outcome, issue?, note?, subject?} → 201 the run, as the schedule lists it.
async fn record_run(State(app): Shared, Path((project, schedule)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    clock_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let id = schedule_id(&mut conn, &schedule).await?;
    let mut runs = ScheduleRuns::new(&mut conn);
    runs.outbox = Some(Outbox::new(actor_of(&headers)));
    let run = runs.record(&project, id, &body_of(&body)).await?;
    Ok(reply(StatusCode::CREATED, Some(run), std::mem::take(&mut runs.effects)))
}

/// `PUT /api/schedules/:schedule/held/:subject` {event, at} → 204: an event held back for the schedule's next minute.
async fn hold_event(State(app): Shared, Path((schedule, subject)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    clock_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let id = schedule_id(&mut conn, &schedule).await?;
    ScheduleRuns::new(&mut conn).hold(id, &subject, &body_of(&body)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `DELETE /api/schedules/:schedule/held/:subject` → {taken}: false when another server took it first.
async fn take_held(State(app): Shared, Path((schedule, subject)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    clock_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let id = schedule_id(&mut conn, &schedule).await?;
    let taken = ScheduleRuns::new(&mut conn).take(id, &subject).await?;
    Ok(Json(serde_json::json!({"taken": taken})).into_response())
}

/// `DELETE /api/schedules/:schedule/held` → 204: what a schedule switched off, or gone, held back.
async fn drop_held(State(app): Shared, Path(schedule): Path<String>, headers: HeaderMap) -> Result<Response> {
    clock_only(&headers)?;
    let mut conn = app.pool.acquire().await?;
    let id = schedule_id(&mut conn, &schedule).await?;
    ScheduleRuns::new(&mut conn).drop_held(id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
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

/// `POST …/schedules/:schedule/adopt` {seen?}: the owner making an agent's schedule theirs (ORR-456).
async fn adopt_schedule(State(app): Shared, Path((project, schedule)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    // No body, or one that isn't JSON, is none, as `readBody(…).catch(() => undefined)` takes it.
    let body = body_of(&body);
    let seen = match body.get("seen") {
        None | Some(Value::Null) => None,
        Some(Value::String(seen)) => Some(seen.clone()),
        Some(_) => return Err(ApiError::bad_request("\"seen\" is the updated_at you read the schedule at")),
    };
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let adopted = schedules.adopt(&project, &schedule, &uid, &actor, seen.as_deref()).await?;
    Ok(reply(StatusCode::OK, Some(adopted), std::mem::take(&mut schedules.effects)))
}

/// `POST …/schedules/enabled` {enabled} → {changed, failed}: the owner pausing or activating all of the project's
/// schedules. A paused one-off isn't activated, as it may have run, and one that fails doesn't stop the rest.
async fn set_all_enabled(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let Some(enabled) = body_of(&body).get("enabled").and_then(Value::as_bool) else {
        return Err(ApiError::bad_request("Send {\"enabled\": true} or {\"enabled\": false}"));
    };
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let done = schedules.set_all_enabled(&project, enabled, &uid, &actor).await?;
    Ok(reply(StatusCode::OK, Some(done), std::mem::take(&mut schedules.effects)))
}

/// `POST …/schedules` {title, cron | at | on, …} → the schedule (201), with its next run worked out.
async fn create_schedule(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let made = schedules.create(&project, &body_of(&body), &uid, &actor).await?;
    Ok(reply(StatusCode::CREATED, Some(made), std::mem::take(&mut schedules.effects)))
}

/// `PATCH …/schedules/:schedule` {any of its fields} → the schedule: `enabled: false` pauses it.
async fn patch_schedule(State(app): Shared, Path((project, schedule)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let changed = schedules.update(&project, &schedule, &body_of(&body), &uid, &actor).await?;
    Ok(reply(StatusCode::OK, Some(changed), std::mem::take(&mut schedules.effects)))
}

/// `DELETE …/schedules/:schedule`: the issues it made stay.
async fn delete_schedule(State(app): Shared, Path((project, schedule)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    schedules.delete(&project, &schedule, &uid, &actor).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut schedules.effects)))
}

async fn schedules_across(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Schedules::new(&mut conn).across().await?).into_response())
}

#[cfg(test)]
#[path = "schedules_tests.rs"]
mod tests;

/// `DELETE /api/schedules/across/:across` → 204: it and the schedules made from it; their issues stay.
/// `POST /api/schedules` {projects: "*" | [ids], skip?, …a schedule's fields} → 201 the schedule across projects, made on
/// each (ORR-1036). The owner's alone.
async fn create_across(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let made = schedules.create_across(&body_of(&body), &uid, &actor).await?;
    Ok(reply(StatusCode::CREATED, Some(made), std::mem::take(&mut schedules.effects)))
}

/// `PATCH /api/schedules/across/:across` {projects?, skip?, …a schedule's fields} → it, changed along with the schedules
/// made from it (ORR-1036).
async fn update_across(State(app): Shared, Path(across): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let uid = Presets::new(&mut conn).uid().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    let changed = schedules.update_across(&across, &body_of(&body), &uid, &actor).await?;
    Ok(reply(StatusCode::OK, Some(changed), std::mem::take(&mut schedules.effects)))
}

async fn delete_across(State(app): Shared, Path(across): Path<String>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let actor = actor_of(&headers);
    let mut schedules = Schedules::new(&mut conn);
    schedules.outbox = Some(Outbox::new(actor.clone()));
    schedules.delete_across(&across, &actor).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut schedules.effects)))
}

/// `POST …/issues/:issue/schedule-requests/:comment` {allow} → the comment asking, answered (ORR-458, ORR-1100): the
/// owner allowing (the schedule is made or changed as theirs) or denying a session's request. Their answer is a comment
/// of theirs, handed on quietly so it starts no session, and the event log's line comes back as `Orrery-Answered`
/// (`<project> <issue> <schedule or -> <fields> <allowed or denied> <line>`, each percent-encoded).
async fn answer_schedule(
    State(app): Shared,
    Path((project, issue, comment)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    let Some(allow) = body_of(&body).get("allow").and_then(Value::as_bool) else {
        return Err(ApiError::bad_request("Send {\"allow\": true} or {\"allow\": false}"));
    };
    let Ok(comment) = comment.parse::<i64>() else {
        return Err(ApiError::bad_request("Send the asking comment's id"));
    };
    let mut conn = app.pool.acquire().await?;
    let actor = actor_of(&headers);
    let answered = ScheduleRequests::new(&mut conn).answer(&app.database, &project, &issue, comment, allow, &actor).await?;
    let mut response = reply(StatusCode::OK, Some(answered.comment.clone()), answered.effects);
    for (header, said) in handoff_headers(&answered.handoff) {
        response.headers_mut().insert(header, HeaderValue::from_str(&said).unwrap());
    }
    let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    let schedule = answered.schedule.map(|id| id.to_string()).unwrap_or_else(|| "-".into());
    let issue = answered.comment["issue"].as_str().unwrap_or(&issue).to_string();
    let how = if allow { "allowed" } else { "denied" };
    let said = format!("{} {} {schedule} {} {how} {}", encode(&project), encode(&issue), encode(&answered.fields.join(",")), encode(&answered.line));
    response.headers_mut().insert("orrery-answered", HeaderValue::from_str(&said).unwrap());
    Ok(response)
}
