// orrery's API in Rust (ORR-922). For now it serves docs, the statuses (ORR-926), milestones and releases (ORR-926, written in ORR-974), reading issues, their comments, their activity and the images uploaded to them (ORR-927), people, invites, keys and logins (ORR-928), presets (ORR-949), reading the secrets, never a value (ORR-953), the settings (ORR-954) reading one pull request as orrery keeps it and rating its risk (ORR-952), the bell (ORR-1005), the epics and their and the milestones' comments (ORR-1004), on the database the Nuxt server opens, and only
// to that server: the router there (web/server/middleware/zz-api.ts) checks a request as it always has (auth, the
// board's permissions, the chat's and untrusted sessions' rails, the browser guards) and then forwards it here with
// who it's from. So this listens on loopback, and answers only a request that carries the token they share.
//
//   NUXT_API_TOKEN     the token they share, as the Nuxt server's setting of that name; required
//   NUXT_DATABASE      the database, as the Nuxt server's setting names it: a SQLite file or a postgres:// URL
//   ORRERY_API_LISTEN  where to listen; 127.0.0.1:9100 by default
//   ORRERY_API_SCHEMA  on Postgres, the schema to work in (the tests' own)
//   ORRERY_API_LOG     1: says each request it answers, and how
//   ORRERY_API_WAIT    1: until the database is there and migrated, tries again each second instead of exiting; for
//                      a container of its own that starts beside the Nuxt server's (the playground's, ORR-1051)
//
// `orrery-api migrate` brings NUXT_DATABASE's schema up to date instead (ORR-931), and exits. Nothing runs it yet: the
// Nuxt server migrates the database as it opens it until the last domain has moved here.
mod changes;
mod chats;
mod choices;
mod comments;
mod db;
mod decisions;
mod docs;
mod epics;
mod error;
mod issue_edits;
mod issue_writes;
mod issues;
mod migrate;
mod milestones;
mod notices;
mod oidc;
mod people;
mod phone;
mod plans;
mod presets;
mod projects;
mod pull_poll;
mod pulls;
mod releases;
mod routes;
mod schedules;
mod secrets;
mod settings;
mod statuses;
mod steps;
mod text;
mod threads;
mod uploads;
mod write;

use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use error::{ApiError, Result};
use people::{People, Ways, Who};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::AnyPool;
use std::sync::Arc;
use write::{Actor, Effects};

struct App {
    pool: AnyPool,
    token: String,
    /// The database's setting, hashed: what the router sends, so a request for another database (the owner moved it in
    /// App settings, and this API wasn't restarted) is turned back rather than written to the old one.
    database: String,
    log: bool,
    /// The phone's one-time sign-in links (ORR-837), kept in memory as the Nuxt server keeps its own.
    phone: phone::Links,
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
    Ways { provider: has("provider"), off: has("off"), on: has("on") }
}

/// How the request reached the router, which only the router's socket knows (ORR-928): `Orrery-Came: loopback, proxied,
/// phone, https`, any of them. `loopback`: its listener is on loopback (or in Docker, published only there). `proxied`:
/// a proxy's headers came with it. `phone`: on the phone's own port. `https`: over https, as the proxy says. With it
/// left out, nothing is assumed: not loopback, so a login is asked for.
#[derive(Default, Clone, Copy)]
struct Came {
    loopback: bool,
    proxied: bool,
    phone: bool,
    https: bool,
}

fn came_of(headers: &HeaderMap) -> Came {
    let said = header(headers, "orrery-came").unwrap_or_default();
    let has = |how: &str| said.split(',').any(|w| w.trim() == how);
    Came { loopback: has("loopback"), proxied: has("proxied"), phone: has("phone"), https: has("https") }
}

/// Whether this orrery asks this request for a login (`authMode`): `off`, `on`, or `closed` when ORRERY_AUTH=off but
/// the request didn't come over loopback, so nobody gets in at all.
async fn auth_mode(people: &mut People<'_>, came: Came, ways: &Ways) -> Result<&'static str> {
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
fn local_host(host: &str) -> bool {
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
fn told_of(told: &write::Told, encode: &impl Fn(&str) -> String) -> String {
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
    if !effects.changed.is_empty() || effects.settings || effects.epics || !effects.told.is_empty() {
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

/// Whether the owner is asking, as `kindOf` has it: the router's `Orrery-Actor-Kind`, so the chat and an untrusted
/// session aren't, whoever they name; the actor's own word without it.
fn owner_asking(headers: &HeaderMap) -> bool {
    match header(headers, "orrery-actor-kind") {
        Some(kind) => kind == "owner",
        None => actor_of(headers).owner,
    }
}

async fn health() -> Json<Value> {
    Json(
        json!({"ok": true, "domains": ["docs", "statuses", "issues, reading", "comments, reading", "activity", "claims", "an issue, deleted", "an issue, its words", "milestones", "releases", "people", "invites", "keys", "logins", "uploads, reading", "presets", "secrets, reading", "settings", "a pull request, reading", "a pull request's risk", "schedules, reading", "projects, listed", "a project, made", "a project, changed", "the bell", "epics", "milestone and epic comments"]}),
    )
}

fn router(app: Arc<App>) -> Router {
    Router::new().route("/health", get(health)).merge(routes::all()).layer(middleware::from_fn_with_state(app.clone(), guard)).with_state(app)
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
    let wait = std::env::var("ORRERY_API_WAIT").is_ok_and(|v| v == "1");
    let mut said = false;
    let pool = loop {
        match db::open(&setting, std::env::var("ORRERY_API_SCHEMA").ok()).await {
            Ok(pool) => break pool,
            Err(e) if wait => {
                if !said {
                    eprintln!("[orrery-api] {e}; trying again each second until it's there (ORRERY_API_WAIT)");
                    said = true;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(e) => fail(e),
        }
    };
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
    let app = Arc::new(App {
        pool,
        token,
        database: database_hash(&named),
        log: std::env::var("ORRERY_API_LOG").is_ok_and(|v| v == "1"),
        phone: phone::Links::default(),
    });
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
