// Reading a request (ORR-1047): who it's from, as the Nuxt router in front sends it (`actor_of`, `who_of`, `ways_of`,
// `came_of`), the guard every request passes, and a body as JSON. The guard checks the shared token, then which
// database it's for, then the login, as web/server/middleware/auth.ts does (ORR-1038): `auth_mode` for how the request
// came, a `closed` one turned away, and with it `on` the credential looked up here, so `Orrery-Who` is this API's own
// finding and never the router's word. Left to the router still: a browser write's `Origin`, and a session's person
// (`holdSession`).
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

const WHO: [&str; 3] = ["orrery-who", "orrery-who-person", "orrery-who-owner"];

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
            "Nobody can log in to this orrery yet: claim it from its page on its own machine (App settings → You), or run `docker compose exec orrery node /app/server/claim.mjs` there",
        ));
    }
    Err(ApiError::unauthorized("This orrery asks for a credential: log in on its page, or give a session an agent key (ORRERY_KEY)"))
}

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
        match checked(&app, request.headers(), open).await {
            Ok(who) => say_who(request.headers_mut(), who.as_ref()),
            Err(refused) => return refused.into_response(),
        }
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

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, HeaderValue::from_static(value));
        }
        headers
    }

    #[test]
    fn who_of_reads_a_browser_or_an_agent_and_nothing_else() {
        let browser = who_of(&headers(&[("orrery-who", "browser"), ("orrery-who-person", "ada"), ("orrery-who-owner", "0")])).unwrap();
        assert_eq!((browser.person.as_str(), browser.owner, browser.browser), ("ada", false, true));
        let agent = who_of(&headers(&[("orrery-who", "agent"), ("orrery-who-person", "steffen"), ("orrery-who-owner", "1")])).unwrap();
        assert_eq!((agent.person.as_str(), agent.owner, agent.browser), ("steffen", true, false));
        // Only `1` is the owner.
        assert!(!who_of(&headers(&[("orrery-who", "browser"), ("orrery-who-person", "ada"), ("orrery-who-owner", "true")])).unwrap().owner);
        assert!(who_of(&headers(&[("orrery-who", "owner"), ("orrery-who-person", "steffen"), ("orrery-who-owner", "1")])).is_none());
        assert!(who_of(&headers(&[("orrery-who", "browser"), ("orrery-who-owner", "1")])).is_none(), "a credential names its person");
        assert!(who_of(&headers(&[("orrery-who", "browser"), ("orrery-who-person", ""), ("orrery-who-owner", "1")])).is_none());
        assert!(who_of(&HeaderMap::new()).is_none());
    }

    #[test]
    fn ways_of_reads_each_way_whole() {
        let ways = ways_of(&headers(&[("orrery-login-ways", "provider, off")]));
        assert!(ways.provider && ways.off && !ways.on);
        assert!(ways_of(&headers(&[("orrery-login-ways", "on")])).on);
        let near = ways_of(&headers(&[("orrery-login-ways", "offline,providers,once")]));
        assert!(!near.provider && !near.off && !near.on);
        let none = ways_of(&HeaderMap::new());
        assert!(!none.provider && !none.off && !none.on);
    }

    #[test]
    fn came_of_assumes_nothing_left_unsaid() {
        let came = came_of(&headers(&[("orrery-came", "loopback,proxied , phone, https")]));
        assert!(came.loopback && came.proxied && came.phone && came.https);
        let none = came_of(&HeaderMap::new());
        assert!(!none.loopback && !none.proxied && !none.phone && !none.https);
        let near = came_of(&headers(&[("orrery-came", "loopbacks, http")]));
        assert!(!near.loopback && !near.https);
    }

    #[test]
    fn local_host_is_only_this_machines_own_address() {
        for host in ["localhost", "localhost:9010", "127.0.0.1", "127.0.0.1:9010", "127.255.0.9:1", "[::1]", "[::1]:9010"] {
            assert!(local_host(host), "{host}");
        }
        for host in [
            "orrery.example",
            "localhost.example",
            "localhost.example:9010",
            "127.0.0.1.example",
            "128.0.0.1",
            "127.1",
            "127.0.0.1000",
            "::1",
            "[::2]:9010",
            "10.0.0.1:9010",
            "",
        ] {
            assert!(!local_host(host), "{host}");
        }
    }

    #[test]
    fn login_of_is_none_when_empty() {
        assert_eq!(login_of(&headers(&[("orrery-login", "abc")])).as_deref(), Some("abc"));
        assert_eq!(login_of(&headers(&[("orrery-login", "")])), None);
        assert_eq!(login_of(&HeaderMap::new()), None);
    }

    #[test]
    fn the_routers_kind_has_the_last_word_on_whether_the_owner_asks() {
        assert!(owner_asking(&headers(&[("orrery-actor-kind", "owner")])));
        for kind in ["chat", "untrusted", "session"] {
            assert!(!owner_asking(&headers(&[("orrery-actor-kind", kind), ("orrery-actor-owner", "1")])), "{kind}");
        }
        assert!(owner_asking(&headers(&[("orrery-actor-owner", "1")])));
        assert!(!owner_asking(&HeaderMap::new()));
    }

    #[test]
    fn a_header_is_percent_decoded() {
        let decoded = header(&headers(&[("orrery-actor-name", "%C3%85se%20Lu")]), "orrery-actor-name");
        assert_eq!(decoded.as_deref(), Some("Åse Lu"));
        assert_eq!(header(&HeaderMap::new(), "orrery-actor-name"), None);
    }

    #[test]
    fn a_body_that_isnt_json_reads_as_null() {
        assert_eq!(body_of(&Bytes::new()), Value::Null);
        assert_eq!(body_of(&Bytes::from_static(b"{nope")), Value::Null);
        assert_eq!(body_of(&Bytes::from_static(br#"{"a":1}"#)), serde_json::json!({"a": 1}));
    }

    /// `auth_mode` for what the router says, on a database of `people` people.
    async fn mode(people: usize, came: &'static str, ways: &'static str) -> &'static str {
        let api = crate::testing::TestApi::new().await;
        for n in 0..people {
            sqlx::query(&crate::db::sql("INSERT INTO people (id, name, role, created_at) VALUES (?, ?, ?, ?)"))
                .bind(format!("p{n}"))
                .bind(format!("P{n}"))
                .bind(if n == 0 { "owner" } else { "member" })
                .bind(crate::write::stamp())
                .execute(&api.app.pool)
                .await
                .unwrap();
        }
        let mut conn = api.app.pool.acquire().await.unwrap();
        let said = headers(&[("orrery-came", came), ("orrery-login-ways", ways)]);
        auth_mode(&mut People::new(&mut conn), came_of(&said), &ways_of(&said)).await.unwrap()
    }

    #[tokio::test]
    async fn auth_mode_is_off_only_on_loopback_for_one_person_or_with_auth_off() {
        let table = [
            (1, "loopback", "", "off"),
            (0, "loopback", "", "off"),
            (2, "loopback", "", "on"),
            (1, "loopback", "on", "on"),
            (1, "loopback, proxied", "", "on"),
            (1, "", "", "on"),
            (1, "https", "", "on"),
            (2, "loopback", "off", "off"),
            (1, "", "off", "closed"),
            (1, "proxied", "off", "closed"),
            (1, "loopback, phone", "", "on"),
            (1, "loopback, phone", "off", "closed"),
            (1, "phone", "off", "closed"),
            // `off` wins over `on`, as ORRERY_AUTH holds one of them.
            (1, "loopback", "on, off", "off"),
        ];
        for (people, came, ways, expected) in table {
            assert_eq!(mode(people, came, ways).await, expected, "{people} people, came {came:?}, ways {ways:?}");
        }
    }

    #[tokio::test]
    async fn auth_mode_stays_on_once_a_second_person_has_been_and_when_the_database_cant_say() {
        let api = crate::testing::TestApi::new().await;
        let said = headers(&[("orrery-came", "loopback")]);
        sqlx::query("INSERT INTO settings (key, value) VALUES ('auth_on', 'true')").execute(&api.app.pool).await.unwrap();
        let mut conn = api.app.pool.acquire().await.unwrap();
        assert_eq!(auth_mode(&mut People::new(&mut conn), came_of(&said), &ways_of(&said)).await.unwrap(), "on");
        sqlx::query("DELETE FROM settings WHERE key = 'auth_on'").execute(&mut *conn).await.unwrap();
        assert_eq!(auth_mode(&mut People::new(&mut conn), came_of(&said), &ways_of(&said)).await.unwrap(), "off");
        sqlx::query("ALTER TABLE people RENAME TO people_gone").execute(&mut *conn).await.unwrap();
        assert_eq!(auth_mode(&mut People::new(&mut conn), came_of(&said), &ways_of(&said)).await.unwrap(), "on");
    }

    #[tokio::test]
    async fn the_guard_compares_the_whole_token() {
        let api = crate::testing::TestApi::new().await;
        let token = crate::testing::TOKEN;
        for wrong in [format!("{token}!"), token[..31].to_string(), String::new(), token.to_uppercase()] {
            let refused = api.get("/api/statuses").header("orrery-api-token", &wrong).send().await;
            assert_eq!(refused.status, 401, "{wrong:?}");
        }
    }

    #[tokio::test]
    async fn the_guard_wants_this_database_named() {
        let api = crate::testing::TestApi::new().await;
        assert_eq!(api.get("/api/statuses").without("orrery-database").send().await.status, 421);
        // The token is checked first, so the database's hash says nothing to a caller without it.
        assert_eq!(api.get("/api/statuses").without("orrery-database").without("orrery-api-token").send().await.status, 401);
        assert_eq!(api.get("/health").without("orrery-database").without("orrery-api-token").send().await.status, 200);
    }

    /// A door-facing orrery with an owner and a member, so login is on.
    async fn two_people() -> crate::testing::TestApi {
        let api = crate::testing::TestApi::at_the_door().await;
        api.owner().await;
        api.member("ada", "ada").await;
        // Login stays on for good once a second person has been here, which the first request would note.
        sqlx::query("INSERT INTO settings (key, value) VALUES ('auth_on', 'true')").execute(&api.app.pool).await.unwrap();
        api
    }

    #[tokio::test]
    async fn with_login_on_a_login_or_an_agent_key_gets_in_and_nothing_else_does() {
        let api = two_people().await;
        api.key("steffen", "person").await;
        let login = api.login("ada").await;
        let agent = api.key("ada", "agent").await;
        assert_eq!(api.get("/api/statuses").header("orrery-login", &login).send().await.status, 200);
        assert_eq!(api.get("/api/statuses").header("orrery-key", &agent).send().await.status, 200);
        let refused = api.get("/api/statuses").send().await;
        assert_eq!(refused.status, 401, "{}", refused.body);
        assert!(refused.body["message"].as_str().unwrap().contains("asks for a credential"));
        let person = api.key("ada", "person").await;
        for (name, value) in [("orrery-key", person.as_str()), ("orrery-key", "nope"), ("orrery-login", "nope"), ("orrery-login", &agent)] {
            assert_eq!(api.get("/api/statuses").header(name, value).send().await.status, 401, "{name}: {value}");
        }
        // The router's word on who it is counts for nothing.
        let said = api.get("/api/statuses").header("orrery-who", "browser").header("orrery-who-person", "steffen").header("orrery-who-owner", "1").send().await;
        assert_eq!(said.status, 401);
    }

    #[tokio::test]
    async fn a_login_run_out_a_revoked_key_or_a_removed_persons_gets_nobody_in() {
        let api = two_people().await;
        api.key("steffen", "person").await;
        let login = api.login("ada").await;
        let agent = api.key("steffen", "agent").await;
        sqlx::query(&crate::db::sql("UPDATE logins SET expires_at = ? WHERE id = ?"))
            .bind("2020-01-01T00:00:00.000Z")
            .bind(&login)
            .execute(&api.app.pool)
            .await
            .unwrap();
        sqlx::query(&crate::db::sql("UPDATE keys SET revoked_at = ? WHERE hash = ?"))
            .bind(crate::write::stamp())
            .bind(&agent)
            .execute(&api.app.pool)
            .await
            .unwrap();
        let gone = api.login("ada").await;
        sqlx::query(&crate::db::sql("UPDATE people SET removed_at = ? WHERE id = 'ada'")).bind(crate::write::stamp()).execute(&api.app.pool).await.unwrap();
        for (name, value) in [("orrery-login", &login), ("orrery-key", &agent), ("orrery-login", &gone)] {
            assert_eq!(api.get("/api/statuses").header(name, value).send().await.status, 401, "{name}");
        }
    }

    #[tokio::test]
    async fn who_the_api_found_is_who_the_route_hears() {
        let api = two_people().await;
        let said = api
            .get("/api/auth/status")
            .header("orrery-login", &api.login("ada").await)
            .header("orrery-who", "browser")
            .header("orrery-who-person", "steffen")
            .header("orrery-who-owner", "1")
            .send()
            .await;
        assert_eq!((said.body["person"].as_str(), said.body["via"].as_str()), (Some("ada"), Some("browser")), "{}", said.body);
        // With login off, nobody's named, whatever the router says.
        let api = crate::testing::TestApi::at_the_door().await;
        let off =
            api.get("/api/auth/status").header("orrery-who", "browser").header("orrery-who-person", "steffen").header("orrery-who-owner", "1").send().await;
        assert!(off.body.get("person").is_none(), "{}", off.body);
    }

    #[tokio::test]
    async fn with_nobody_able_to_log_in_its_said_rather_than_asked_for() {
        let api = two_people().await;
        let stuck = api.get("/api/statuses").send().await;
        assert_eq!(stuck.status, 503, "{}", stuck.body);
        assert!(stuck.body["message"].as_str().unwrap().starts_with("Nobody can log in"));
        // A provider is a way in, and the phone's port has its own sign-in link.
        assert_eq!(api.get("/api/statuses").header("orrery-login-ways", "provider").send().await.status, 401);
        assert_eq!(api.get("/api/statuses").header("orrery-came", "loopback, phone").send().await.status, 401);
    }

    #[tokio::test]
    async fn closed_turns_everything_away_but_the_logins_own_routes() {
        let api = two_people().await;
        let login = api.login("steffen").await;
        for came in ["", "proxied", "loopback, phone"] {
            let closed = api.get("/api/statuses").header("orrery-came", came).header("orrery-login-ways", "off").header("orrery-login", &login).send().await;
            assert_eq!(closed.status, 503, "{came:?}: {}", closed.body);
            assert!(closed.body["message"].as_str().unwrap().starts_with("ORRERY_AUTH=off only works"));
            let status = api.get("/api/auth/status").header("orrery-came", came).header("orrery-login-ways", "off").send().await;
            assert_eq!((status.status.as_u16(), status.body["mode"].as_str()), (200, Some("closed")));
        }
    }

    #[tokio::test]
    async fn off_on_loopback_and_the_servers_own_work_need_no_login() {
        let api = crate::testing::TestApi::at_the_door().await;
        assert_eq!(api.get("/api/statuses").send().await.status, 200, "one person on loopback");
        let api = two_people().await;
        assert_eq!(api.get("/api/statuses").header("orrery-came", "server").send().await.status, 200);
        // `server` is the whole of what's said, not one of several ways.
        assert_eq!(api.get("/api/statuses").header("orrery-came", "loopback, server").send().await.status, 503);
    }

    #[tokio::test]
    async fn a_body_past_the_limit_is_refused_in_nuxts_words() {
        let api = crate::testing::TestApi::new().await;
        let project = api.project("big").await;
        let docs = format!("/api/projects/{project}/docs");
        let big = api.post(&docs, serde_json::json!({"title": "Big", "body": "x".repeat(BODY_LIMIT)})).send().await;
        assert_eq!(big.status, 413);
        assert_eq!(big.body["message"], "A request's body is 1 MB at most here", "JSON, as the Nuxt server says it");
        assert_eq!(big.body["statusMessage"], "Payload Too Large");
        let fits = api.post(&docs, serde_json::json!({"title": "Fits", "body": "x".repeat(BODY_LIMIT - 1024)})).send().await;
        assert_eq!(fits.status, 201, "just under it is kept: {}", fits.body);
    }
}
