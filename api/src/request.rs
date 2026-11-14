// Reading a request (ORR-1047): who it's from, as the Nuxt router in front sends it (`actor_of`, `who_of`, `ways_of`,
// `came_of`), the guard every request passes, and a body as JSON. The guard checks the shared token, then which
// database it's for, then the login, as web/server/middleware/auth.ts does (ORR-1038): `auth_mode` for how the request
// came, a `closed` one turned away, and with it `on` the credential looked up here, so `Orrery-Who` is this API's own
// finding and never the router's word. A write is then checked as the middleware checks it after that (ORR-1081): a
// browser's has to say which page it's from (`Origin`), and one with an agent key can't write as a session that's
// another person's (`holdSession`). Whether that `Origin` is ours stays with the router's browser guards (writes.ts).
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
        // Only the local app's own work names a run, as it's what keeps a write from setting schedules off.
        cause: header(headers, "orrery-cause").filter(|c| came_of(headers).server && !c.is_empty() && c.bytes().all(|b| b.is_ascii_digit())),
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
    let workspace = header(headers, "orrery-who-workspace").filter(|w| !w.is_empty());
    Some(Who { person, owner: header(headers, "orrery-who-owner").as_deref() == Some("1"), browser, workspace })
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
/// left out, nothing is assumed: not loopback, so a login is asked for. `server` alone is the Nuxt server's own work
/// (`writeToApi`, the outbox's follower), which no outside request set off, so there's no login to check (ORR-1038).
#[derive(Default, Clone, Copy)]
pub(crate) struct Came {
    pub(crate) loopback: bool,
    pub(crate) proxied: bool,
    pub(crate) phone: bool,
    pub(crate) https: bool,
    pub(crate) server: bool,
}

pub(crate) fn came_of(headers: &HeaderMap) -> Came {
    let said = header(headers, "orrery-came").unwrap_or_default();
    let has = |how: &str| said.split(',').any(|w| w.trim() == how);
    Came { loopback: has("loopback"), proxied: has("proxied"), phone: has("phone"), https: has("https"), server: said.trim() == "server" }
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

/// The request's bearer, hashed as the keys table keeps it (`Orrery-Key`): the key itself stays with the router.
fn key_of(headers: &HeaderMap) -> Option<String> {
    header(headers, "orrery-key").filter(|k| !k.is_empty())
}

/// What a login isn't asked for, as `OPEN` in web/server/middleware/auth.ts: the login's own routes, a phone's
/// one-time link among them, which can't hold data.
const OPEN: [&str; 6] = ["/api/auth/status", "/api/auth/login", "/api/auth/logout", "/api/auth/link", "/api/auth/oidc/start", "/api/auth/oidc/callback"];

const WHO: [&str; 4] = ["orrery-who", "orrery-who-person", "orrery-who-owner", "orrery-who-workspace"];

/// Who the request is, checked here as the auth middleware checks it: `Ok(None)` with no login asked for, `Ok(Some)`
/// with the credential found, and the refusal otherwise. `open` is a login route, which goes on with no credential.
async fn checked(app: &crate::App, headers: &HeaderMap, open: bool) -> Result<Option<Who>> {
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    let came = came_of(headers);
    let ways = ways_of(headers);
    match auth_mode(&mut people, came, &ways).await? {
        "off" => return Ok(None),
        "closed" if open => return Ok(None),
        "closed" => {
            return Err(ApiError::unavailable(
                "ORRERY_AUTH=off only works while orrery listens on loopback, and this one is reachable from other machines: unset it",
            ))
        }
        _ => {}
    }
    let who = people.credential(key_of(headers).as_deref(), login_of(headers).as_deref()).await?;
    if who.is_some() || open {
        return Ok(who);
    }
    if !came.phone && !ways.provider && !people.owner_has_key().await? {
        return Err(ApiError::unavailable(
            "Nobody can log in to this orrery yet: claim it from its page on its own machine (App settings → You), or run `pnpm orrery:claim` there (in Docker, `docker compose exec orrery node /app/server/claim.mjs`)",
        ));
    }
    Err(ApiError::unauthorized("This orrery asks for a credential: log in on its page, or give a session an agent key (ORRERY_KEY)"))
}

/// What a write by `who` has to show after its credential (ORR-1081), as web/server/middleware/auth.ts asks. A cookie
/// goes along by itself, so a browser's write says it comes from a page (`Orrery-Sent-Origin`, the request's `Origin`).
/// And a session is the person's whose agent key it first wrote with (`holdSession`, ORR-705): the router claims it in
/// `session_people` before the request comes here, so this only reads whose it is, and refuses another person's key.
async fn write_checked(app: &crate::App, headers: &HeaderMap, who: &Who) -> Result<()> {
    if who.browser {
        if !header(headers, "orrery-sent-origin").is_some_and(|o| !o.is_empty()) {
            return Err(ApiError::forbidden("A logged-in write comes from orrery's own page"));
        }
        return Ok(());
    }
    let Some(session) = header(headers, "orrery-session").filter(|s| !s.is_empty()) else { return Ok(()) };
    let mut conn = app.pool.acquire().await?;
    match People::new(&mut conn).session_holder(&session).await? {
        Some(holder) if holder != who.person => {
            Err(ApiError::conflict(format!("This session is {holder}'s, and this is {}'s agent key, so it can't write as that session", who.person)))
        }
        _ => Ok(()),
    }
}

const WRITES: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];

/// `Orrery-Who` as this API found it, in place of whatever the router said.
fn say_who(headers: &mut HeaderMap, who: Option<&Who>) {
    for name in WHO {
        headers.remove(name);
    }
    let Some(who) = who else { return };
    let person = percent_encoding::utf8_percent_encode(&who.person, percent_encoding::NON_ALPHANUMERIC).to_string();
    for (name, value) in [
        ("orrery-who", if who.browser { "browser" } else { "agent" }.to_string()),
        ("orrery-who-person", person),
        ("orrery-who-owner", if who.owner { "1" } else { "0" }.into()),
        ("orrery-who-workspace", who.workspace.clone().unwrap_or_default()),
    ] {
        if let Ok(value) = axum::http::HeaderValue::from_str(&value) {
            headers.insert(name, value);
        }
    }
}

/// What a request's body may be (`LIMIT` in web/server/middleware/big-bodies.ts): eight times the biggest doc there is.
pub(crate) const BODY_LIMIT: usize = 1024 * 1024;

/// axum's own refusal of a body past the limit is plain text: said again as the JSON 413 the Nuxt server sends.
fn too_large(response: Response) -> Response {
    let json = response.headers().get(axum::http::header::CONTENT_TYPE).is_some_and(|t| t.as_bytes().starts_with(b"application/json"));
    if response.status() != axum::http::StatusCode::PAYLOAD_TOO_LARGE || json {
        return response;
    }
    ApiError::too_large(format!("A request's body is {} MB at most here", BODY_LIMIT / 1024 / 1024)).into_response()
}

pub(crate) async fn guard(State(app): Shared, mut request: Request, next: Next) -> Response {
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
    // The Nuxt server's own work says who it's for in its own words. Anything else has its login checked here.
    if !came_of(request.headers()).server {
        let open = OPEN.contains(&request.uri().path());
        let who = match checked(&app, request.headers(), open).await {
            Ok(who) => who,
            Err(refused) => return refused.into_response(),
        };
        if let Some(who) = who.as_ref().filter(|_| !open && WRITES.contains(&request.method().as_str())) {
            if let Err(refused) = write_checked(&app, request.headers(), who).await {
                return refused.into_response();
            }
        }
        say_who(request.headers_mut(), who.as_ref());
    }
    let said = app.log.then(|| format!("{} {}", request.method(), request.uri()));
    let response = too_large(next.run(request).await);
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
#[path = "request_tests.rs"]
mod tests;
