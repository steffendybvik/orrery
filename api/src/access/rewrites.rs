// What the owner's chat and an untrusted schedule's session ask to make, rewritten before it's made (ORR-1059), as
// the Nuxt server's route does (`asChatIssue` in web/server/utils/chats.ts, `asProposal` in utils/untrusted.ts): the
// chat's issue lands with nobody on it in the status the owner picked for the chat, and an untrusted session's becomes
// a proposal labelled `external`. What only the Nuxt server knows comes with the request: the chat's status
// (`Orrery-Chat-Issues`) and the session the issue is noted as worked by (`Orrery-Worked-By`), its id after a `/clear`.
use axum::http::HeaderMap;
use percent_encoding::percent_decode_str;
use serde_json::{Map, Value};

/// The label on what an untrusted run's session raises (`EXTERNAL`).
pub(crate) const EXTERNAL: &str = "external";

/// The statuses the owner can pick for the chat's issues (`chatIssuesOf`): Todo unless it's Backlog.
fn chat_status(headers: &HeaderMap) -> &'static str {
    match headers.get("orrery-chat-issues").and_then(|v| v.to_str().ok()).map(str::trim) {
        Some("backlog") => "backlog",
        _ => "todo",
    }
}

/// An issue as the chat asks to make it (`asChatIssue`): no status, plan or assignee of its own, in the chat's status
/// unless it's a proposal, which stays one for the owner to decide. A body that isn't an object is left for the route
/// to refuse.
pub(crate) fn as_chat_issue(body: Value, headers: &HeaderMap) -> Value {
    let Value::Object(mut rest) = body else { return body };
    for key in ["status", "plan", "assignee"] {
        rest.remove(key);
    }
    if rest.get("proposal").and_then(Value::as_str) != Some("pending") {
        rest.insert("status".into(), Value::String(chat_status(headers).into()));
    }
    Value::Object(rest)
}

/// An issue as an untrusted session asks to make it (`asProposal`): its title, notes, choices and GitHub issues alone,
/// made a proposal labelled `external`, with nothing that puts it among the owner's work or that a schedule could match.
pub(crate) fn as_proposal(body: &Value) -> Value {
    let mut kept = Map::new();
    let sent = body.as_object();
    for key in ["title", "notes", "choices", "github_issues"] {
        if let Some(value) = sent.and_then(|o| o.get(key)) {
            kept.insert(key.into(), value.clone());
        }
    }
    kept.insert("proposal".into(), Value::String("pending".into()));
    kept.insert("labels".into(), Value::Array(vec![Value::String(EXTERNAL.into())]));
    Value::Object(kept)
}

/// The session a new issue is noted as worked by (`workedOn`): the one the router names, never the chat's, as what it
/// makes is for others to work.
pub(crate) fn worked_by(headers: &HeaderMap, chat: bool) -> Option<String> {
    if chat {
        return None;
    }
    let sent = headers.get("orrery-worked-by")?.to_str().ok()?;
    let session = percent_decode_str(sent).decode_utf8().ok()?.trim().to_string();
    (!session.is_empty()).then_some(session)
}

#[cfg(test)]
#[path = "rewrites_tests.rs"]
mod tests;
