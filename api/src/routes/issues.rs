// Issues: reading them, their comments and activity, claims, edits, decisions, bulk changes and deletes: the handlers
// and the routes they answer (ORR-1048).
use super::P;
use crate::access::rewrites;
use crate::board::comments::{comment_id, Handoff};
use crate::board::issue_edits;
use crate::board::issue_writes::IssueWrites;
use crate::board::issues::Issues;
use crate::changes::Outbox;
use crate::error::{ApiError, Result};
use crate::reply::reply;
use crate::request::{actor_of, body_of, came_of};
use crate::{changes, write, App, Shared};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route(&format!("{P}/issues"), get(list_issues).post(create_issue).patch(update_issues).delete(delete_issues))
        .route(&format!("{P}/issues/{{issue}}"), get(get_issue).patch(patch_issue).delete(delete_issue))
        .route(&format!("{P}/issues/{{issue}}/row"), get(issue_row))
        .route(&format!("{P}/issues/{{issue}}/id"), get(issue_id))
        .route(&format!("{P}/issues/{{issue}}/claim"), post(claim_issue).delete(release_issue))
        .route(&format!("{P}/issues/{{issue}}/decide"), post(decide_issue))
        .route(&format!("{P}/issues/decide"), post(decide_issues))
        .route(&format!("{P}/issues/{{issue}}/comments"), get(list_comments).post(create_comment))
        .route(&format!("{P}/issues/{{issue}}/comments/{{comment}}"), get(get_comment).patch(patch_comment).delete(delete_comment))
        .route(&format!("{P}/issues/{{issue}}/activity"), get(get_activity))
        .route(&format!("{P}/issues/{{issue}}/said"), post(said_on_issue))
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
    Ok(Json(IssueWrites::new(&mut conn).list(&project, &issue).await?).into_response())
}

/// `POST …/issues/{issue}/comments`: the new comment, and in `Orrery-Carry` and `Orrery-Notice` (`<project> <issue>
/// <comment>`, each part percent-encoded) what the router passes on to the session on the issue and the owner's bell.
async fn create_comment(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    let (value, handoff) = comments.create(&project, &issue, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut comments.effects);
    let mut response = reply(StatusCode::CREATED, Some(value), effects);
    for (header, said) in handoff_headers(&handoff) {
        response.headers_mut().insert(header, HeaderValue::from_str(&said).unwrap());
    }
    Ok(response)
}

/// `POST …/issues/{issue}/said`: orrery's own word on the issue (ORR-1094), from the Nuxt server's own work alone (a
/// pull request's news, a schedule's note), with in `Orrery-Carry` whether to pass it on to the session on the issue.
async fn said_on_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    if !came_of(&headers).server {
        return Err(ApiError::forbidden("Only orrery itself says things as orrery"));
    }
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    let (value, handoff) = comments.said(&project, &issue, &body_of(&body)).await?;
    let effects = std::mem::take(&mut comments.effects);
    let mut response = reply(StatusCode::CREATED, Some(value), effects);
    for (header, said) in handoff_headers(&handoff) {
        response.headers_mut().insert(header, HeaderValue::from_str(&said).unwrap());
    }
    Ok(response)
}

/// The headers many comments' `Handoff`s are said in, each header's apart by commas.
fn handoffs_headers(handoffs: &[Handoff]) -> Vec<(&'static str, String)> {
    let mut said: Vec<(&'static str, Vec<String>)> = vec![];
    for (header, one) in handoffs.iter().flat_map(handoff_headers) {
        match said.iter_mut().find(|(h, _)| *h == header) {
            Some((_, all)) => all.push(one),
            None => said.push((header, vec![one])),
        }
    }
    said.into_iter().map(|(header, all)| (header, all.join(", "))).collect()
}

/// The headers a new comment's `Handoff` is said in.
pub(crate) fn handoff_headers(handoff: &Handoff) -> Vec<(&'static str, String)> {
    let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    let edited = if handoff.edited {
        " edited"
    } else if handoff.quiet {
        " quiet"
    } else {
        ""
    };
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
    let mut comments = IssueWrites::new(&mut conn);
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
    let mut comments = IssueWrites::new(&mut conn);
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

/// `POST …/issues` with only an issue's own words (`issue_edits::WORDS`): 201 the new issue (`createIssue`), and
/// `Orrery-Urgent` when it's urgent open work. An untrusted session's is made a proposal and the chat's lands in its
/// status with nobody on it (`rewrites`), and the session the router names is noted as working it (`workedOn`).
async fn create_issue(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let actor = actor_of(&headers);
    let sent = body_of(&body);
    let asked = if actor.untrusted {
        rewrites::as_proposal(&sent)
    } else if actor.chat {
        rewrites::as_chat_issue(sent, &headers)
    } else {
        sent
    };
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor.clone()));
    let (id, urgent) = comments.create_issue(&project, &asked, &actor).await?;
    // The issue's made: not noting its session only means the owner's comments on it don't reach that session.
    if let Some(session) = rewrites::worked_by(&headers, actor.chat) {
        if let Err(error) = comments.worked_by(&project, &id, &session).await {
            eprintln!("[orrery-api] tying {project}/{id} to its session: {error:?}");
        }
    }
    let effects = std::mem::take(&mut comments.effects);
    let value = Issues::new(&mut conn).issue(&project, &id).await?;
    let mut response = reply(StatusCode::CREATED, Some(value), effects);
    // Urgent open work: the Nuxt server pushes it to the sessions (`sayUrgent`), as only it reaches them.
    if urgent {
        let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
        response.headers_mut().insert("orrery-urgent", HeaderValue::from_str(&format!("{} {}", encode(&project), encode(&id))).unwrap());
    }
    Ok(response)
}

/// `PATCH …/issues/{issue}` with only an issue's own words and priority (`issue_edits::WORDS`): the issue
/// (`updateIssue`), and `Orrery-Urgent` when it made it urgent open work. A session (`Orrery-Worked-By`) changing its
/// status is noted as working it, and starting it takes the session's lock on it (`claimed`, 409 when another has it).
async fn patch_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    let actor = actor_of(&headers);
    let mut edit = body_of(&body);
    // Sent with `project`, it moves there first (ORR-1129), with its new parent or milestone, and the rest of the edit
    // is made there.
    let (mut project, mut issue) = (project, issue);
    let mut moved_from: Vec<String> = vec![];
    let mut moved = false;
    if let Some(fields) = edit.as_object_mut() {
        if let Some(to) = fields.remove("project") {
            let Some(to) = to.as_str().map(str::to_string) else {
                return Err(ApiError::bad_request(format!("\"project\" should be a string, not {}", write::js(&to))));
            };
            if to != project {
                let text = |value: Option<Value>| match value {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::String(sent)) => Ok(Some(sent)),
                    Some(other) => Err(other),
                };
                let parent =
                    text(fields.remove("parent")).map_err(|v| ApiError::bad_request(format!("\"parent\" should be a string, not {}", write::js(&v))))?;
                let milestone =
                    text(fields.remove("milestone")).map_err(|v| ApiError::bad_request(format!("\"milestone\" should be a string, not {}", write::js(&v))))?;
                let assignee = fields.get("assignee").map(|a| a.as_str().map(str::to_string));
                issue = comments.move_issue(&project, &issue, &to, parent.as_deref(), milestone.as_deref(), assignee, &actor).await?;
                project = to;
                moved = true;
                moved_from = std::mem::take(&mut comments.effects.changed);
            }
        }
    }
    // A session's change of status (`claimed`, ORR-1130): starting the issue takes the session's lock on it, which the
    // router let through once the session's claim held, and the issue is noted as the session's work.
    let moves_status = edit.get("status").is_some() || edit.get("plan").is_some();
    let session = if actor.owner || !moves_status { None } else { rewrites::worked_by(&headers, actor.chat) };
    comments.session = session.clone();
    let urgent = comments.edit_words(&project, &issue, &edit, &actor).await?;
    // It's edited: not noting its session only means the owner's comments on it don't reach that session. Moved, it's
    // the session's work where it is now, which its address doesn't say (`workedOn`).
    let worked = session.or_else(|| if moved { rewrites::worked_by(&headers, actor.chat) } else { None });
    if let Some(session) = &worked {
        if let Err(error) = comments.worked_by(&project, &issue, session).await {
            eprintln!("[orrery-api] tying {project}/{issue} to its session: {error:?}");
        }
    }
    let mut effects = std::mem::take(&mut comments.effects);
    for other in moved_from {
        if !effects.changed.contains(&other) {
            effects.changed.push(other);
        }
    }
    let value = Issues::new(&mut conn).issue(&project, &issue).await?;
    let mut response = reply(StatusCode::OK, Some(value), effects);
    // Made urgent open work: the Nuxt server pushes it to the sessions (`sayUrgent`), as only it reaches them.
    if let Some(id) = urgent {
        let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
        response.headers_mut().insert("orrery-urgent", HeaderValue::from_str(&format!("{} {}", encode(&project), encode(&id))).unwrap());
    }
    Ok(response)
}

/// `POST …/issues/{issue}/decide` `{decision, note?, picks?, explore?}`: the owner's decision on a proposal (`decide`),
/// the issue, with its comment's `Orrery-Carry` (` quiet` for a rejection, which starts no work) and `Orrery-Urgent` when
/// approving made it urgent open work.
async fn decide_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    let (id, handoff, urgent) = comments.decide(&project, &issue, &body_of(&body), &actor_of(&headers)).await?;
    let effects = std::mem::take(&mut comments.effects);
    let value = Issues::new(&mut conn).issue(&project, &id).await?;
    let mut response = reply(StatusCode::OK, Some(value), effects);
    for (header, said) in handoff_headers(&handoff) {
        response.headers_mut().insert(header, HeaderValue::from_str(&said).unwrap());
    }
    if urgent {
        let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
        response.headers_mut().insert("orrery-urgent", HeaderValue::from_str(&format!("{} {}", encode(&project), encode(&id))).unwrap());
    }
    Ok(response)
}

/// `POST …/issues/decide` `{ids, decision, note?}`: the owner's one decision on many proposals, each on its own as one
/// is decided, so one refused doesn't stop the rest (`decideIssues`). Picks and explore go one at a time. `[{id, ok,
/// error?}]`, an id once however often it's sent; each comment comes back in `Orrery-Carry`, and the ones approving
/// made urgent in `Orrery-Urgent`, apart by commas.
async fn decide_issues(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.project_uid(&project).await?;
    let sent = body_of(&body);
    let mut decision = sent.as_object().cloned().unwrap_or_default();
    let ids = decision.remove("ids");
    if decision.contains_key("picks") || decision.contains_key("explore") {
        return Err(ApiError::bad_request("Many proposals at once take a decision and a note; picks and explore go one at a time"));
    }
    let ids = match ids {
        Some(Value::Array(ids)) if !ids.is_empty() && ids.iter().all(Value::is_string) => {
            ids.iter().filter_map(|id| id.as_str().map(String::from)).collect::<Vec<_>>()
        }
        _ => return Err(ApiError::bad_request(r#"Send "ids": the issues, as a list of their ids"#)),
    };
    let decision = Value::Object(decision);
    let actor = actor_of(&headers);
    let mut effects = write::Effects::default();
    let (mut urgent, mut handoffs, mut results) = (vec![], vec![], vec![]);
    let mut seen: Vec<&String> = vec![];
    for sent in &ids {
        if seen.contains(&sent) {
            continue;
        }
        seen.push(sent);
        // Each decision is its own writes, as in the store: their own transactions and their own rows in the outbox.
        comments.outbox = Some(Outbox::new(actor.clone()));
        let done = comments.decide_one_of_many(&project, sent, &decision, &actor).await;
        let said = std::mem::take(&mut comments.effects);
        match done {
            Ok((id, handoff, made)) => {
                if !said.changed.is_empty() {
                    effects.changed = said.changed;
                }
                effects.told.extend(said.told);
                handoffs.push(handoff);
                if made {
                    urgent.push(id);
                }
                results.push(json!({"id": sent, "ok": true}));
            }
            Err(error) => results.push(json!({"id": sent, "ok": false, "error": error.message})),
        }
    }
    // Once the batch ends the store says the project changed once more, for open pages (`each`): its row too.
    if !effects.changed.is_empty() {
        let once = write::Effects { changed: effects.changed.clone(), ..Default::default() };
        let conn = &mut *conn;
        changes::begin(conn).await?;
        changes::finish(conn, Some(&mut Outbox::new(actor)), &once, Ok(())).await?;
    }
    let mut response = reply(StatusCode::OK, Some(Value::Array(results)), effects);
    for (header, said) in handoffs_headers(&handoffs) {
        response.headers_mut().insert(header, HeaderValue::from_str(&said).unwrap());
    }
    if !urgent.is_empty() {
        let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
        let said = urgent.iter().map(|id| format!("{} {}", encode(&project), encode(id))).collect::<Vec<_>>().join(", ");
        response.headers_mut().insert("orrery-urgent", HeaderValue::from_str(&said).unwrap());
    }
    Ok(response)
}

/// `DELETE …/issues/{issue}`: 204, its sub-issues and comments gone with it (`deleteIssue`).
async fn delete_issue(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    comments.delete_issue(&project, &issue, &actor_of(&headers)).await?;
    Ok(reply(StatusCode::NO_CONTENT, None, std::mem::take(&mut comments.effects)))
}

/// `DELETE …/issues` `{ids}`: many deleted, each on its own as one is, so one refused doesn't stop the rest
/// (`deleteIssues`). `[{id, ok, error?}]`, an id once however often it's sent; one already gone with an issue above it
/// is ok.
async fn delete_issues(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.project_uid(&project).await?;
    let sent = body_of(&body);
    let ids = match sent.get("ids") {
        Some(Value::Array(ids)) if !ids.is_empty() && ids.iter().all(Value::is_string) => {
            ids.iter().filter_map(|id| id.as_str().map(String::from)).collect::<Vec<_>>()
        }
        _ => return Err(ApiError::bad_request(r#"Send "ids": the issues, as a list of their ids"#)),
    };
    let actor = actor_of(&headers);
    let mut effects = write::Effects::default();
    let mut gone: Vec<String> = vec![];
    let mut results = vec![];
    let mut seen: Vec<&String> = vec![];
    for sent in &ids {
        if seen.contains(&sent) {
            continue;
        }
        seen.push(sent);
        // Each delete is its own write, as in the store: its own transaction and its own rows in the outbox.
        comments.outbox = Some(Outbox::new(actor.clone()));
        let done: Result<()> = async {
            let id = comments.issue_id(&project, sent).await?;
            if gone.contains(&id) {
                return Ok(());
            }
            let subtree = comments.subtree(&project, &id).await?;
            comments.delete_issue(&project, &id, &actor).await?;
            gone.extend(subtree);
            Ok(())
        }
        .await;
        let said = std::mem::take(&mut comments.effects);
        match done {
            Ok(()) => {
                if !said.changed.is_empty() {
                    effects.changed = said.changed;
                }
                effects.told.extend(said.told);
                results.push(json!({"id": sent, "ok": true}));
            }
            Err(error) => results.push(json!({"id": sent, "ok": false, "error": error.message})),
        }
    }
    // Once the batch ends the store says the project changed once more, for open pages (`each`): its row too.
    if !effects.changed.is_empty() {
        let once = write::Effects { changed: effects.changed.clone(), ..Default::default() };
        let conn = &mut *conn;
        changes::begin(conn).await?;
        changes::finish(conn, Some(&mut Outbox::new(actor)), &once, Ok(())).await?;
    }
    Ok(reply(StatusCode::OK, Some(Value::Array(results)), effects))
}

/// `PATCH …/issues` `{ids, set?: {status?, priority?, assignee?, milestone?, release?, epic?}, labels?: {add?, remove?}}`:
/// one change to many issues, each on its own as one is edited, so one refused doesn't stop the rest (`updateIssues`).
/// `[{id, ok, error?}]`, an id once however often it's sent. The ones it made urgent come back in `Orrery-Urgent`.
async fn update_issues(State(app): Shared, Path(project): Path<String>, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.project_uid(&project).await?;
    let sent = body_of(&body);
    // As `Object.keys` reads what's sent as `set`: a string's or a list's are its places.
    let (set, keys) = match sent.get("set") {
        Some(Value::Object(set)) => (set.clone(), set.keys().cloned().collect::<Vec<_>>()),
        Some(Value::String(text)) => (Default::default(), (0..text.encode_utf16().count()).map(|n| n.to_string()).collect()),
        Some(Value::Array(list)) => (Default::default(), (0..list.len()).map(|n| n.to_string()).collect()),
        _ => (Default::default(), vec![]),
    };
    let others: Vec<&String> = keys.iter().filter(|key| !issue_edits::BULK.contains(&key.as_str())).collect();
    if !others.is_empty() {
        let others = others.iter().map(|key| key.as_str()).collect::<Vec<_>>().join(", ");
        return Err(ApiError::bad_request(format!(
            r#"Many issues at once take {} in "set", and labels as {{add, remove}}; not {others}"#,
            issue_edits::BULK.join(", ")
        )));
    }
    let list = |key: &str| -> Result<Vec<String>> {
        match sent.get("labels").and_then(Value::as_object).and_then(|labels| labels.get(key)) {
            None => Ok(vec![]),
            Some(Value::Array(labels)) if labels.iter().all(Value::is_string) => Ok(labels.iter().filter_map(|l| l.as_str().map(String::from)).collect()),
            Some(_) => Err(ApiError::bad_request(format!(r#""labels.{key}" should be a list of labels"#))),
        }
    };
    let (add, remove) = (list("add")?, list("remove")?);
    let ids = match sent.get("ids") {
        Some(Value::Array(ids)) if !ids.is_empty() && ids.iter().all(Value::is_string) => {
            ids.iter().filter_map(|id| id.as_str().map(String::from)).collect::<Vec<_>>()
        }
        _ => return Err(ApiError::bad_request(r#"Send "ids": the issues, as a list of their ids"#)),
    };
    let actor = actor_of(&headers);
    let mut effects = write::Effects::default();
    let mut urgent: Vec<String> = vec![];
    let mut results = vec![];
    let mut seen: Vec<&String> = vec![];
    for sent in &ids {
        if seen.contains(&sent) {
            continue;
        }
        seen.push(sent);
        // Each edit is its own write, as in the store: its own transaction and its own rows in the outbox.
        comments.outbox = Some(Outbox::new(actor.clone()));
        let done = comments.edit_one_of_many(&project, sent, &set, &add, &remove, &actor).await;
        let said = std::mem::take(&mut comments.effects);
        match done {
            Ok(made) => {
                if !said.changed.is_empty() {
                    effects.changed = said.changed;
                }
                effects.told.extend(said.told);
                urgent.extend(made);
                results.push(json!({"id": sent, "ok": true}));
            }
            Err(error) => results.push(json!({"id": sent, "ok": false, "error": error.message})),
        }
    }
    // Once the batch ends the store says the project changed once more, for open pages (`each`): its row too.
    if !effects.changed.is_empty() {
        let once = write::Effects { changed: effects.changed.clone(), ..Default::default() };
        let conn = &mut *conn;
        changes::begin(conn).await?;
        changes::finish(conn, Some(&mut Outbox::new(actor)), &once, Ok(())).await?;
    }
    let mut response = reply(StatusCode::OK, Some(Value::Array(results)), effects);
    // Made urgent open work: the Nuxt server pushes each to the sessions (`sayUrgent`), as only it reaches them.
    if !urgent.is_empty() {
        let encode = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
        let said = urgent.iter().map(|id| format!("{} {}", encode(&project), encode(id))).collect::<Vec<_>>().join(", ");
        response.headers_mut().insert("orrery-urgent", HeaderValue::from_str(&said).unwrap());
    }
    Ok(response)
}

async fn claim_or_release(app: Arc<App>, project: String, issue: String, headers: HeaderMap, claim: bool) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let mut comments = IssueWrites::new(&mut conn);
    comments.outbox = Some(Outbox::new(actor_of(&headers)));
    let actor = actor_of(&headers);
    let id = if claim { comments.claim(&project, &issue, &actor).await? } else { comments.release(&project, &issue, &actor).await? };
    let effects = std::mem::take(&mut comments.effects);
    let value = Issues::new(&mut conn).issue(&project, &id).await?;
    Ok(reply(StatusCode::OK, Some(value), effects))
}

async fn get_activity(State(app): Shared, Path((project, issue)): Path<(String, String)>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    Ok(Json(IssueWrites::new(&mut conn).activity(&project, &issue).await?).into_response())
}

async fn get_comment(State(app): Shared, Path((project, issue, comment)): Path<(String, String, String)>) -> Result<Response> {
    let id = comment_id(&comment)?;
    let mut conn = app.pool.acquire().await?;
    Ok(Json(IssueWrites::new(&mut conn).comment(&project, &issue, id).await?).into_response())
}

#[cfg(test)]
#[path = "issues_tests.rs"]
mod tests;

/// `GET …/issues/:issue/row` → the issue's row as it's stored, by its id alone (no alias), for the local app's store
/// (ORR-1174), whose helpers read it to check an issue is there and for its assignee, labels, claim and the rest. A 404
/// for a project or an issue there isn't, as the store says each.
async fn issue_row(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    if !came_of(&headers).server {
        return Err(ApiError::forbidden("Only the local app reads an issue's row"));
    }
    let mut conn = app.pool.acquire().await?;
    if sqlx::query(&crate::db::sql("SELECT 1 FROM projects WHERE id = ?")).bind(&project).fetch_optional(&mut *conn).await?.is_none() {
        return Err(ApiError::not_found(format!("No project \"{project}\"")));
    }
    let row = sqlx::query(&crate::db::sql("SELECT * FROM issues WHERE project = ? AND id = ?"))
        .bind(&project)
        .bind(&issue)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("No issue {issue} in {project}")))?;
    Ok(Json(crate::db::row_json(&row)).into_response())
}

/// `GET …/issues/:issue/id` → `{id}`: the issue's id from its id, one it had before (an alias), or the full form of
/// either, for the local app's store (`issueId`, ORR-1174). The id sent comes back when nothing matches, as the store
/// leaves it to the read after to say there's no such issue; a 404 for a project there isn't.
async fn issue_id(State(app): Shared, Path((project, issue)): Path<(String, String)>, headers: HeaderMap) -> Result<Response> {
    if !came_of(&headers).server {
        return Err(ApiError::forbidden("Only the local app resolves an issue's id"));
    }
    let mut conn = app.pool.acquire().await?;
    Ok(Json(json!({"id": Issues::new(&mut conn).resolve(&project, &issue, false).await?})).into_response())
}
