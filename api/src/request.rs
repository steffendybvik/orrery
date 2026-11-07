// Reading a request (ORR-1047): who it's from, as the Nuxt router in front sends it (`actor_of`, `who_of`, `ways_of`,
// `came_of`), the guard every request passes (the shared token, then the login mode), and a body as JSON.
use crate::access::people::{People, Ways, Who};
use crate::error::{ApiError, Result};
use crate::write::Actor;
use crate::Shared;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use percent_encoding::percent_decode_str;
use serde_json::Value;

pub(crate) fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(name)?.to_str().ok()?;
    Some(percent_decode_str(raw).decode_utf8_lossy().into_owned())
}

/// Who the router says the request is from. It sends the name and session percent-encoded, as a header holds only ASCII.
pub(crate) fn actor_of(headers: &HeaderMap) -> Actor {
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
pub(crate) fn who_of(headers: &HeaderMap) -> Option<Who> {
    let browser = match header(headers, "orrery-who").as_deref() {
        Some("browser") => true,
        Some("agent") => false,
        _ => return None,
    };
    let person = header(headers, "orrery-who-person").filter(|p| !p.is_empty())?;
    Some(Who { person, owner: header(headers, "orrery-who-owner").as_deref() == Some("1"), browser })
}

/// What the router's settings say about getting in: `Orrery-Login-Ways: provider, off`, either or both.
pub(crate) fn ways_of(headers: &HeaderMap) -> Ways {
    let said = header(headers, "orrery-login-ways").unwrap_or_default();
    let has = |way: &str| said.split(',').any(|w| w.trim() == way);
    Ways { provider: has("provider"), off: has("off"), on: has("on") }
}

/// How the request reached the router, which only the router's socket knows (ORR-928): `Orrery-Came: loopback, proxied,
/// phone, https`, any of them. `loopback`: its listener is on loopback (or in Docker, published only there). `proxied`:
/// a proxy's headers came with it. `phone`: on the phone's own port. `https`: over https, as the proxy says. With it
/// left out, nothing is assumed: not loopback, so a login is asked for.
#[derive(Default, Clone, Copy)]
pub(crate) struct Came {
    pub(crate) loopback: bool,
    pub(crate) proxied: bool,
    pub(crate) phone: bool,
    pub(crate) https: bool,
}

pub(crate) fn came_of(headers: &HeaderMap) -> Came {
    let said = header(headers, "orrery-came").unwrap_or_default();
    let has = |how: &str| said.split(',').any(|w| w.trim() == how);
    Came { loopback: has("loopback"), proxied: has("proxied"), phone: has("phone"), https: has("https") }
}

/// Whether this orrery asks this request for a login (`authMode`): `off`, `on`, or `closed` when ORRERY_AUTH=off but
/// the request didn't come over loopback, so nobody gets in at all.
pub(crate) async fn auth_mode(people: &mut People<'_>, came: Came, ways: &Ways) -> Result<&'static str> {
    // The phone's port always asks (ORR-837), whatever the main one does.
    if came.phone {
        return Ok(if ways.off { "closed" } else { "on" });
    }
    if ways.off {
        return Ok(if came.loopback { "off" } else { "closed" });
    }
    if ways.on || !came.loopback || came.proxied {
        return Ok("on");
    }
    // A database that can't say keeps it on, as the Nuxt server does.
    Ok(if people.auth_stays_on().await.unwrap_or(true) { "on" } else { "off" })
}

/// Whether the address asked for is this machine's own, where plain http is fine: `localhost`, `127.x.y.z` or `[::1]`.
pub(crate) fn local_host(host: &str) -> bool {
    let name = match host.rsplit_once(':') {
        Some((name, port)) if !host.ends_with(']') && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    };
    name == "localhost" || name == "[::1]" || {
        let parts: Vec<&str> = name.split('.').collect();
        parts.len() == 4 && parts[0] == "127" && parts[1..].iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    }
}

/// The asking browser's login, hashed as the logins table keeps it: the cookie itself stays with the router.
pub(crate) fn login_of(headers: &HeaderMap) -> Option<String> {
    header(headers, "orrery-login").filter(|l| !l.is_empty())
}

pub(crate) async fn guard(State(app): Shared, request: Request, next: Next) -> Response {
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

pub(crate) fn body_of(bytes: &Bytes) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).unwrap_or(Value::Null)
    }
}

/// Whether the owner is asking, as `kindOf` has it: the router's `Orrery-Actor-Kind`, so the chat and an untrusted
/// session aren't, whoever they name; the actor's own word without it.
pub(crate) fn owner_asking(headers: &HeaderMap) -> bool {
    match header(headers, "orrery-actor-kind") {
        Some(kind) => kind == "owner",
        None => actor_of(headers).owner,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

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
