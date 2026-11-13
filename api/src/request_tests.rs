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
    let off = api.get("/api/auth/status").header("orrery-who", "browser").header("orrery-who-person", "steffen").header("orrery-who-owner", "1").send().await;
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

/// A project's docs, the project made by the owner's agent key, as the guard lets in nothing else.
async fn docs_of(api: &crate::testing::TestApi) -> String {
    let key = api.key("steffen", "agent").await;
    let made = api.post("/api/projects", serde_json::json!({"name": "Primes"})).header("orrery-key", &key).send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    format!("/api/projects/{}/docs", made.body["id"].as_str().unwrap())
}

#[tokio::test]
async fn a_logged_in_browsers_write_has_to_say_which_page_its_from() {
    let api = two_people().await;
    api.key("steffen", "person").await;
    let login = api.login("steffen").await;
    let docs = docs_of(&api).await;
    let bare = api.post(&docs, serde_json::json!({"title": "Plan"})).signed_in(&login).without("orrery-sent-origin").send().await;
    assert_eq!(bare.status, 403, "{}", bare.body);
    assert_eq!(bare.body["message"], "A logged-in write comes from orrery's own page");
    assert_eq!(api.post(&docs, serde_json::json!({"title": "Plan"})).signed_in(&login).header("orrery-sent-origin", "").send().await.status, 403);
    let sent =
        api.post(&docs, serde_json::json!({"title": "Plan"})).signed_in(&login).header("orrery-sent-origin", "http%3A%2F%2Flocalhost%3A9000").send().await;
    assert_eq!(sent.status, 201, "{}", sent.body);
    // A read needs none, nor does an agent key's write, nor logging out.
    assert_eq!(api.get(&docs).signed_in(&login).send().await.status, 200);
    let agent = api.key("steffen", "agent").await;
    assert_eq!(api.post(&docs, serde_json::json!({"title": "Agent's"})).header("orrery-key", &agent).send().await.status, 201);
    assert_ne!(api.post("/api/auth/logout", serde_json::json!({})).signed_in(&login).send().await.status, 403);
}

#[tokio::test]
async fn behind_the_router_logging_out_goes_by_the_hashed_login_and_the_address_the_browser_asked_for() {
    let api = two_people().await;
    api.key("steffen", "person").await;
    let login = api.login("ada").await;
    assert_eq!(api.get("/api/statuses").header("orrery-login", &login).send().await.status, 200);
    let out = api.post("/api/auth/logout", serde_json::json!({})).header("orrery-login", &login).header("orrery-host", "localhost%3A9123").send().await;
    assert_eq!(out.status, 204, "{}", out.body);
    assert_eq!(out.header("set-cookie"), Some("orrery_login_9123=; Max-Age=0; Path=/"));
    assert_eq!(api.get("/api/statuses").header("orrery-login", &login).send().await.status, 401);
    // Through a proxy on 443 the address has no port, and the cookie is plain `orrery_login`.
    let plain = api.post("/api/auth/logout", serde_json::json!({})).header("orrery-host", "orrery.example").send().await;
    assert_eq!(plain.header("set-cookie"), Some("orrery_login=; Max-Age=0; Path=/"));
}

#[tokio::test]
async fn an_agent_key_cant_write_as_another_persons_session() {
    let api = two_people().await;
    api.key("steffen", "person").await;
    let docs = docs_of(&api).await;
    let ada = api.key("ada", "agent").await;
    let steffen = api.key("steffen", "agent").await;
    api.session_held_by("s 1", "ada").await;
    let theirs = api.post(&docs, serde_json::json!({"title": "Mine"})).header("orrery-key", &steffen).header("orrery-session", "s%201").send().await;
    assert_eq!(theirs.status, 409, "{}", theirs.body);
    assert_eq!(theirs.body["message"], "This session is ada's, and this is steffen's agent key, so it can't write as that session");
    let own = api.post(&docs, serde_json::json!({"title": "Ada's"})).header("orrery-key", &ada).header("orrery-session", "s%201").send().await;
    assert_eq!(own.status, 201, "{}", own.body);
    // A session nobody holds yet, a read, and a browser's write naming it go by.
    let free = api.post(&docs, serde_json::json!({"title": "New"})).header("orrery-key", &steffen).header("orrery-session", "s2").send().await;
    assert_eq!(free.status, 201, "{}", free.body);
    assert_eq!(api.get(&docs).header("orrery-key", &steffen).header("orrery-session", "s%201").send().await.status, 200);
    let login = api.login("steffen").await;
    let page = api
        .post(&docs, serde_json::json!({"title": "Page"}))
        .signed_in(&login)
        .header("orrery-sent-origin", "http%3A%2F%2Flocalhost")
        .header("orrery-session", "s%201");
    assert_eq!(page.send().await.status, 201);
    assert_eq!(api.count("SELECT count(*) AS n FROM session_people").await, 1, "the API only reads whose a session is");
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
