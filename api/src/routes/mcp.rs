// `/mcp`, orrery's MCP tools over streamable HTTP (ORR-1098): the handlers and the routes they answer. What each JSON-RPC
// message gets is mcp/mod.rs's; this is the HTTP around it.
use crate::error::{ApiError, Result};
use crate::mcp::tools::Kind;
use crate::mcp::{end_session, new_session, Call};
use crate::request::{actor_of, header, who_of};
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/mcp", post(post_mcp).get(get_mcp).delete(delete_mcp))
}

const SESSION: &str = "mcp-session-id";

/// A session's tools are an agent's: a browser's login doesn't get them, so a page can't be made to call them.
fn agents_only(headers: &HeaderMap) -> Result<()> {
    if who_of(headers).is_some_and(|who| who.browser) {
        return Err(ApiError::forbidden("orrery's MCP tools are for agents: give the session an agent key as its bearer"));
    }
    Ok(())
}

fn kind_of(headers: &HeaderMap) -> Kind {
    let actor = actor_of(headers);
    match (actor.chat, actor.untrusted) {
        (true, _) => Kind::Chat,
        (_, true) => Kind::Untrusted,
        _ => Kind::Work,
    }
}

/// `POST /mcp`: one JSON-RPC message, or a batch of them, answered as JSON. Only notifications: 202 and no body.
async fn post_mcp(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    agents_only(&headers)?;
    let Ok(sent) = serde_json::from_slice::<Value>(&body) else {
        let said = json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Not JSON"}});
        return Ok((StatusCode::BAD_REQUEST, Json(said)).into_response());
    };
    let batch = sent.is_array();
    let messages = match sent {
        Value::Array(messages) => messages,
        message => vec![message],
    };
    let initializes = messages.iter().any(|m| m["method"] == "initialize");
    // A new session's id on `initialize`, whatever it came with; else the one it came with.
    let session = if initializes { Some(new_session()) } else { header(&headers, SESSION).filter(|s| !s.is_empty()) };
    let call = Call { kind: kind_of(&headers), session: session.as_deref() };
    let mut conn = app.pool.acquire().await?;
    let mut answers = Vec::new();
    for message in &messages {
        if let Some(answer) = call.answer(&mut conn, message).await? {
            answers.push(answer);
        }
    }
    let mut response = if answers.is_empty() {
        StatusCode::ACCEPTED.into_response()
    } else if batch {
        Json(Value::Array(answers)).into_response()
    } else {
        Json(answers.remove(0)).into_response()
    };
    if let Some(id) = session.filter(|_| initializes).and_then(|id| HeaderValue::from_str(&id).ok()) {
        response.headers_mut().insert(SESSION, id);
    }
    Ok(response)
}

/// `GET /mcp`: the stream a server could ask the client things on. This one asks nothing, so it has none.
async fn get_mcp(headers: HeaderMap) -> Result<Response> {
    agents_only(&headers)?;
    Ok((StatusCode::METHOD_NOT_ALLOWED, [("allow", "POST, DELETE")]).into_response())
}

/// `DELETE /mcp`: the client is done with its session, so the groups it loaded are let go.
async fn delete_mcp(headers: HeaderMap) -> Result<Response> {
    agents_only(&headers)?;
    let Some(session) = header(&headers, SESSION).filter(|s| !s.is_empty()) else {
        return Err(ApiError::bad_request("Say which session: Mcp-Session-Id"));
    };
    Ok(if end_session(&session) { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }.into_response())
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
