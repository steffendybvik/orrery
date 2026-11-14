// The browser guards (ORR-1173), checked here as well as by the Nuxt router (web/server/middleware/writes.ts), so the API
// doesn't take its word for them. Alone on one machine there are no accounts, so orrery guards against the owner's own
// browser being used against it: a website open there could post a form and plant issues or comments for the sessions to
// read, or point its own domain at this machine (DNS rebinding) to read the board and write to it.
//
// - Only the names this machine goes by are answered: localhost (and *.localhost), an IP address, a Bonjour name
//   (`<name>.local`), or one NUXT_ALLOWED_HOSTS lists. The name is the one the browser asked the router for (`Orrery-Host`).
// - A write to `/api` from a page on another site (`Orrery-Sent-Origin`, the request's `Origin`) is refused, unless
//   NUXT_ALLOWED_ORIGINS lists that site (ORR-667). Agents, curl and the channel send none.
// - A write's body must be JSON, which a page on another site can't send without the browser asking first.
//
// A request without `Orrery-Host` didn't come through the router's door (only a holder of the token can send one), so
// there's no browser's address to check. The sessions' streams stay the router's: they aren't served here.
use super::oidc::{allowed_origins, origin_allowed};
use crate::error::{ApiError, Result};
use crate::request::header;
use axum::http::{HeaderMap, StatusCode};
use url::Url;

const WRITES: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];

/// What the guards go by besides the request: NUXT_ALLOWED_HOSTS and NUXT_ALLOWED_ORIGINS, as they were set when the
/// API started, which is when the Nuxt server read them too.
pub(crate) struct Allowed {
    pub(crate) hosts: String,
    pub(crate) origins: String,
}

impl Allowed {
    pub(crate) fn from_env() -> Self {
        Allowed { hosts: std::env::var("NUXT_ALLOWED_HOSTS").unwrap_or_default(), origins: allowed_origins() }
    }
}

/// Refuses what the router's browser guards refuse: a host this orrery doesn't go by, a write from another site's page,
/// or a write whose body isn't JSON.
pub(crate) fn browser_checked(allowed: &Allowed, headers: &HeaderMap, method: &str, path: &str) -> Result<()> {
    let Some(host) = header(headers, "orrery-host").filter(|h| !h.is_empty()) else { return Ok(()) };
    let name = name_of(&host);
    let listed = allowed.hosts.split(',').map(|h| h.trim().to_lowercase()).any(|h| !h.is_empty() && h == name.to_lowercase());
    if !local_name(name) && !listed {
        return Err(ApiError::forbidden(format!("orrery doesn't answer to \"{name}\"; add it to NUXT_ALLOWED_HOSTS")));
    }
    if !(WRITES.contains(&method) && path.starts_with("/api/")) {
        return Ok(());
    }
    if let Some(origin) = header(headers, "orrery-sent-origin").filter(|o| !o.is_empty()) {
        if (origin == "null" || host_of(&origin).as_deref() != Some(host.as_str())) && !origin_allowed(&allowed.origins, &origin) {
            return Err(ApiError::forbidden("orrery takes writes from its own page, not another site's"));
        }
    }
    let length = headers.get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0);
    let has_body = length > 0 || headers.contains_key("transfer-encoding");
    let json = headers.get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|t| t.to_lowercase().starts_with("application/json"));
    if has_body && !json {
        return Err(ApiError {
            status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
            message: "Send the body as JSON (Content-Type: application/json)".into(),
            data: None,
        });
    }
    Ok(())
}

/// The host's name, without its port.
fn name_of(host: &str) -> &str {
    match host.rsplit_once(':') {
        Some((name, port)) if !host.ends_with(']') && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    }
}

/// A name this machine goes by (`LOCAL` in writes.ts): localhost or `*.localhost`, a one-label `.local` (Bonjour, looked
/// up on the local network alone), an IPv4 address, or a bracketed IPv6 one.
fn local_name(name: &str) -> bool {
    let name = name.to_lowercase();
    if name == "localhost" || (name.ends_with(".localhost") && name.len() > ".localhost".len()) {
        return true;
    }
    if let Some(label) = name.strip_suffix(".local") {
        let ends = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric());
        return (1..=63).contains(&label.len())
            && ends(label.as_bytes().first())
            && ends(label.as_bytes().last())
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    }
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit())) {
        return true;
    }
    name.len() > 2 && name.starts_with('[') && name.ends_with(']') && name[1..name.len() - 1].bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
}

/// The host of an `Origin` (with its port, unless it's the scheme's own), or none when it isn't a URL.
fn host_of(origin: &str) -> Option<String> {
    let url = Url::parse(origin).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;
