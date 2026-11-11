// The tools ORR-1101 listed as needing the machine whose work is already this API's: the event log (`events`,
// `resolve_event`, routes/event_log.rs), the secrets' list (`secrets`, never a value) and the chat's pasted images
// (`image`, routes/uploads.rs), each as channel/tools.mjs runs it.
//
// The rest stay in the channel, as their work is on the machine the session runs on: `egress` opens a secret with the
// machine's key, which the API never holds (decision-rust-api-secrets-settings); `github_issues` and `github_pulls`
// run `gh` in the session's folder; `link_folder` writes the launcher's list there. The chat's `reply` waits on the
// chat moving into the API (ORR-1100).
use super::{enc, text, truthy, Api, No, Said};
use axum::http::{header, Method};
use base64::Engine;
use serde_json::{json, Value};

impl Api<'_> {
    /// The event log, newest first, a line each (with its details when asked), filtered as the route filters.
    pub(super) async fn events(&self, args: &Value) -> Said {
        let details = args.get("details").is_some_and(truthy);
        // As the channel's query: every argument but `details`, then `limit` (30), leaving out what's missing, false
        // or blank, and true as 1.
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            let mut limit = json!(30);
            for (key, value) in args.as_object().into_iter().flatten() {
                match key.as_str() {
                    "details" => {}
                    "limit" => limit = value.clone(),
                    _ => push(&mut query, key, value),
                }
            }
            push(&mut query, "limit", &limit);
            query.finish()
        };
        let events = self.list(&format!("/api/events/log?{query}")).await?;
        if events.is_empty() {
            return Ok("Nothing in the event log for that.".into());
        }
        let lines: Vec<String> = events.iter().map(|e| event(e, details)).collect();
        Ok(lines.join(if details { "\n\n" } else { "\n" }))
    }

    pub(super) async fn resolve_event(&self, args: &Value) -> Said {
        let id = args.get("id").map(text).unwrap_or_else(|| "undefined".into());
        let event = self.call(Method::POST, &format!("/api/events/log/{}/resolve", enc(&id)), None).await?;
        Ok(format!("Resolved #{} {}: {}", text(&event["id"]), text(&event["kind"]), text(&event["message"])))
    }

    /// The secrets egress can use, with their hosts and the projects they're held to.
    pub(super) async fn secrets(&self) -> Said {
        let lines: Vec<String> = self
            .list("/api/secrets")
            .await?
            .iter()
            .map(|s| {
                let only = match s["projects"].as_array() {
                    Some(projects) => format!(" (only {})", joined(projects)),
                    None => String::new(),
                };
                format!("{} → {}{only}", text(&s["name"]), joined(s["hosts"].as_array().map(Vec::as_slice).unwrap_or_default()))
            })
            .collect();
        Ok(if lines.is_empty() { "No secrets yet; the owner sets them on App settings.".into() } else { lines.join("\n") })
    }

    /// An image the owner pasted in the chat, as itself: an MCP result with its data, not text.
    pub(crate) async fn image(&self, args: &Value) -> std::result::Result<Value, No> {
        let id = args.get("id").map(text).unwrap_or_else(|| "undefined".into());
        if id.len() != 24 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(No(format!("{id} isn't an upload's id")));
        }
        let (status, headers, bytes) = self.send(Method::GET, &format!("/api/uploads/{id}"), None).await?;
        if !status.is_success() {
            return Err(No(format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or(""))));
        }
        let kind = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("image/png");
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(json!({"content": [{"type": "image", "data": data, "mimeType": kind}]}))
    }
}

/// A filter in the query, as the channel puts it: none when missing, false or blank, and true as 1.
fn push(query: &mut url::form_urlencoded::Serializer<'_, String>, key: &str, value: &Value) {
    match value {
        Value::Bool(false) => {}
        Value::String(s) if s.is_empty() => {}
        Value::Bool(true) => {
            query.append_pair(key, "1");
        }
        other => {
            query.append_pair(key, &js_string(other));
        }
    }
}

/// A value as JavaScript's `String()` gives it: a list's items joined with commas.
fn js_string(value: &Value) -> String {
    match value {
        Value::Array(items) => items.iter().map(|i| if i.is_null() { String::new() } else { js_string(i) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => text(other),
    }
}

fn joined(items: &[Value]) -> String {
    items.iter().map(text).collect::<Vec<_>>().join(", ")
}

/// A line of the log, as the channel writes it.
fn event(e: &Value, details: bool) -> String {
    let reported = if truthy(&e["details"]["reported"]) { " (reported by a page: anyone can send one, so not checked)" } else { "" };
    let project = if truthy(&e["project"]) { format!(" ({})", text(&e["project"])) } else { String::new() };
    let count = if e["count"].as_f64().is_some_and(|c| c > 1.0) { format!(" ×{}", text(&e["count"])) } else { String::new() };
    let resolved = if truthy(&e["resolved_at"]) {
        if truthy(&e["resolved_by"]) {
            format!(", resolved by {}", text(&e["resolved_by"]))
        } else {
            ", resolved".into()
        }
    } else {
        String::new()
    };
    let mut said = format!(
        "#{} [{}] {}{reported}{project}{count}, last {}{resolved}: {}",
        text(&e["id"]),
        text(&e["level"]),
        text(&e["kind"]),
        text(&e["last_seen"]),
        text(&e["message"])
    );
    if details && truthy(&e["details"]) {
        said.push('\n');
        said.push_str(&serde_json::to_string_pretty(&e["details"]).unwrap_or_default());
    }
    said
}

#[cfg(test)]
#[path = "machine_tests.rs"]
mod tests;
