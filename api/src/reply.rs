// Replying (ORR-1047): the body, and what the write changed (`Effects`) as the `orrery-*` headers the Nuxt router reads
// to tell open pages, the event log and schedules. Waking the change streams too, as the write is committed by now.
use crate::write::Effects;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::Value;

/// One event as `Orrery-Told` says it: `<type> <project> <subject>`, then `<from> <to>` when a value changed, `~` for
/// one that's none (an encoded value is never a bare `~`).
pub(crate) fn told_of(told: &crate::write::Told, encode: &impl Fn(&str) -> String) -> String {
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
pub(crate) fn reply(status: StatusCode, body: Option<Value>, effects: Effects) -> Response {
    // The write is committed by now, with its outbox rows: the open streams can send them (ORR-929).
    if !effects.changed.is_empty() || effects.settings || effects.epics || !effects.told.is_empty() {
        crate::changes::wake();
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
    if effects.epics {
        response.headers_mut().insert("orrery-epics", HeaderValue::from_static("1"));
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
