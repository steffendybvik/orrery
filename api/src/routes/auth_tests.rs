// The tests of routes/auth.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::access::phone::{self, LINK_MINUTES, PHONE_LOGIN, WRONG_CODES};
use crate::testing::{Reply, Req, TestApi};
use crate::write::stamp;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;

/// A key for `person` made as the owner with login off: its id and its secret.
async fn key(api: &TestApi, person: &str, kind: &str) -> (String, String) {
    let made = api.post("/api/keys", json!({"kind": kind, "name": "laptop", "person": person})).header("orrery-actor-name", "Steffen").send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    (made.body["id"].as_str().unwrap().into(), made.body["key"].as_str().unwrap().into())
}

fn hash(secret: &str) -> String {
    Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The secret a login's `Set-Cookie` carries.
fn cookie_secret(reply: &Reply) -> String {
    let cookie = reply.header("set-cookie").expect("a login cookie");
    cookie.split(';').next().unwrap().split_once('=').unwrap().1.to_string()
}

async fn status(req: Req) -> Value {
    let reply = req.send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.body
}

async fn logins(api: &TestApi) -> Vec<(String, String, Option<String>, Option<String>)> {
    sqlx::query("SELECT id, person, by_key, name FROM logins")
        .fetch_all(&api.app.pool)
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get("id"), r.get("person"), r.get("by_key"), r.get("name")))
        .collect()
}

#[tokio::test]
async fn logging_in_swaps_a_person_key_for_an_http_only_cookie_named_for_the_port() {
    let api = TestApi::new().await;
    api.owner().await;
    let (id, secret) = key(&api, "steffen", "person").await;
    let reply = api.post("/api/auth/login", json!({"key": format!("  {secret}\n")})).header("host", "localhost:9010").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!({"person": "steffen"}));
    let cookie = reply.header("set-cookie").unwrap();
    assert!(cookie.starts_with("orrery_login_9010="), "{cookie}");
    assert!(cookie.contains("; Max-Age=2592000; Path=/; HttpOnly;") && cookie.ends_with("SameSite=Lax") && !cookie.contains("Secure"), "{cookie}");
    let kept = logins(&api).await;
    assert_eq!(kept, [(hash(&cookie_secret(&reply)), "steffen".to_string(), Some(id), None)], "only the cookie's hash is kept, with the key that started it");
}

#[tokio::test]
async fn a_login_cookie_is_secure_over_https_and_plain_without_a_port() {
    let api = TestApi::new().await;
    api.owner().await;
    let (_, secret) = key(&api, "steffen", "person").await;
    let proxied = api.post("/api/auth/login", json!({"key": secret})).header("host", "orrery.example").header("x-forwarded-proto", "https,http").send().await;
    let cookie = proxied.header("set-cookie").unwrap();
    assert!(cookie.starts_with("orrery_login=") && cookie.contains(" Secure;"), "{cookie}");
    let came = api.post("/api/auth/login", json!({"key": secret})).header("orrery-came", "proxied, https").send().await;
    assert!(came.header("set-cookie").unwrap().contains(" Secure;"));
}

#[tokio::test]
async fn an_agent_key_a_revoked_key_or_a_removed_persons_never_logs_in() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "ada").await;
    let (_, agent) = key(&api, "steffen", "agent").await;
    let (revoked_id, revoked) = key(&api, "steffen", "person").await;
    assert_eq!(api.delete(&format!("/api/keys/{revoked_id}")).header("orrery-actor-name", "Steffen").send().await.status, 204);
    let (_, adas) = key(&api, "ada", "person").await;
    sqlx::query(&crate::db::sql("UPDATE people SET removed_at = ? WHERE id = 'ada'")).bind(stamp()).execute(&api.app.pool).await.unwrap();
    for body in
        [json!({"key": agent}), json!({"key": revoked}), json!({"key": adas}), json!({"key": "orrery_person_nope"}), json!({}), json!({"key": 1}), Value::Null]
    {
        let refused = api.post("/api/auth/login", body.clone()).send().await;
        assert_eq!(refused.status, 401, "{body}: {}", refused.body);
        assert!(refused.header("set-cookie").is_none());
    }
    assert!(logins(&api).await.is_empty());
}

#[tokio::test]
async fn logging_out_ends_this_browsers_login_on_the_server_too() {
    let api = TestApi::new().await;
    api.owner().await;
    let (_, secret) = key(&api, "steffen", "person").await;
    let mine = cookie_secret(&api.post("/api/auth/login", json!({"key": secret})).header("host", "localhost:9010").send().await);
    let other = cookie_secret(&api.post("/api/auth/login", json!({"key": secret})).header("host", "localhost:9010").send().await);
    // A cookie under another port's name isn't this orrery's.
    let elsewhere =
        api.post("/api/auth/logout", json!(null)).header("host", "localhost:9010").header("cookie", &format!("orrery_login_9011={mine}")).send().await;
    assert_eq!(elsewhere.status, 204);
    assert_eq!(logins(&api).await.len(), 2);
    let out = api
        .post("/api/auth/logout", json!(null))
        .header("host", "localhost:9010")
        .header("cookie", &format!("theme=dark; orrery_login_9010={mine}"))
        .send()
        .await;
    assert_eq!(out.status, 204);
    assert_eq!(out.header("set-cookie"), Some("orrery_login_9010=; Max-Age=0; Path=/"));
    let left: Vec<String> = logins(&api).await.into_iter().map(|l| l.0).collect();
    assert_eq!(left, [hash(&other)]);
}

#[tokio::test]
async fn logging_out_without_a_login_still_clears_the_cookie() {
    let api = TestApi::new().await;
    let out = api.request(axum::http::Method::POST, "/api/auth/logout").send().await;
    assert_eq!(out.status, 204);
    assert_eq!(out.header("set-cookie"), Some("orrery_login=; Max-Age=0; Path=/"));
}

#[tokio::test]
async fn status_is_off_on_loopback_for_one_person_and_says_nothing_of_anyone() {
    let api = TestApi::new().await;
    api.owner().await;
    let said = status(api.get("/api/auth/status").without("orrery-actor-name").without("orrery-actor-owner")).await;
    assert_eq!(said, json!({"mode": "off", "can_get_in": false, "oidc": false, "warn_http": false, "phone": false}));
}

#[tokio::test]
async fn status_asks_for_a_login_off_loopback_behind_a_proxy_or_when_told_to() {
    let api = TestApi::new().await;
    api.owner().await;
    for (came, ways) in [("", ""), ("proxied", ""), ("loopback, proxied", ""), ("loopback", "on")] {
        let said = status(api.get("/api/auth/status").header("orrery-came", came).header("orrery-login-ways", ways)).await;
        assert_eq!(said["mode"], "on", "came {came:?}, ways {ways:?}");
    }
    let said = status(api.get("/api/auth/status").without("orrery-came")).await;
    assert_eq!(said["mode"], "on", "nothing said is nothing assumed");
}

#[tokio::test]
async fn status_is_closed_with_auth_off_anywhere_but_loopback() {
    let api = TestApi::new().await;
    api.owner().await;
    let off = |came: &str| api.get("/api/auth/status").header("orrery-came", came).header("orrery-login-ways", "off");
    assert_eq!(status(off("loopback")).await["mode"], "off");
    assert_eq!(status(off("")).await["mode"], "closed");
    assert_eq!(status(off("proxied")).await["mode"], "closed");
    assert_eq!(status(off("loopback, proxied")).await["mode"], "off");
}

#[tokio::test]
async fn the_phones_port_always_asks_for_a_login() {
    let api = TestApi::new().await;
    api.owner().await;
    let phone = status(api.get("/api/auth/status").header("orrery-came", "loopback, phone")).await;
    assert_eq!((phone["mode"].as_str(), phone["phone"].as_bool()), (Some("on"), Some(true)));
    let off = status(api.get("/api/auth/status").header("orrery-came", "loopback, phone").header("orrery-login-ways", "off")).await;
    assert_eq!(off["mode"], "closed");
}

#[tokio::test]
async fn a_second_person_turns_login_on_for_good() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "ada").await;
    assert_eq!(status(api.get("/api/auth/status")).await["mode"], "on");
    sqlx::query(&crate::db::sql("UPDATE people SET removed_at = ? WHERE id = 'ada'")).bind(stamp()).execute(&api.app.pool).await.unwrap();
    assert_eq!(status(api.get("/api/auth/status")).await["mode"], "on", "it stays on after they go");
}

#[tokio::test]
async fn status_says_someone_can_get_in_with_a_provider_or_the_owners_person_key() {
    let api = TestApi::new().await;
    api.owner().await;
    assert_eq!(status(api.get("/api/auth/status").header("orrery-login-ways", "provider")).await["can_get_in"], true);
    assert_eq!(status(api.get("/api/auth/status").header("orrery-login-ways", "provider")).await["oidc"], true);
    key(&api, "steffen", "agent").await;
    assert_eq!(status(api.get("/api/auth/status")).await["can_get_in"], false, "an agent key signs nobody in");
    key(&api, "steffen", "person").await;
    assert_eq!(status(api.get("/api/auth/status")).await["can_get_in"], true);
}

#[tokio::test]
async fn status_says_who_this_browser_or_agent_is() {
    let api = TestApi::new().await;
    api.owner().await;
    let said = status(api.get("/api/auth/status").browser("steffen", true)).await;
    assert_eq!((said["person"].as_str(), said["via"].as_str()), (Some("steffen"), Some("browser")));
    let said = status(api.get("/api/auth/status").header("orrery-who", "agent").header("orrery-who-person", "steffen")).await;
    assert_eq!(said["via"], "agent");
    let said = status(api.get("/api/auth/status").header("orrery-who", "browser")).await;
    assert!(said.get("person").is_none(), "a credential without its person is none: {said}");
}

#[tokio::test]
async fn status_warns_of_plain_http_only_to_another_machine() {
    let api = TestApi::new().await;
    api.owner().await;
    let on = |came: &str, host: &str| api.get("/api/auth/status").header("orrery-came", came).header("orrery-host", host);
    assert_eq!(status(on("", "orrery.example")).await["warn_http"], true);
    assert_eq!(status(on("", "192.168.1.4:9010")).await["warn_http"], true);
    for host in ["localhost:9010", "127.0.0.1:9010", "[::1]:9010", "localhost"] {
        assert_eq!(status(on("", host)).await["warn_http"], false, "{host}");
    }
    assert_eq!(status(on("https", "orrery.example")).await["warn_http"], false);
    // Off, there's no login to send in the clear.
    assert_eq!(status(on("loopback", "orrery.example")).await["warn_http"], false);
    // `Host` stands in when the router doesn't say.
    assert_eq!(status(api.get("/api/auth/status").header("orrery-came", "").header("host", "orrery.example")).await["warn_http"], true);
}

#[tokio::test]
async fn the_owner_makes_a_sign_in_link_good_for_five_minutes() {
    let api = TestApi::new().await;
    api.owner().await;
    let made = api.post("/api/phone/link", json!(null)).send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    assert!(made.body["token"].as_str().unwrap().len() >= 20);
    let code = made.body["code"].as_str().unwrap();
    assert!(code.len() == 6 && code.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()), "{code}");
    let expires = chrono::DateTime::parse_from_rfc3339(made.body["expires_at"].as_str().unwrap()).unwrap().with_timezone(&chrono::Utc);
    let left = (expires - chrono::Utc::now()).num_seconds();
    assert!(left > LINK_MINUTES * 60 - 10 && left <= LINK_MINUTES * 60, "{left}s");
    // With login on, from the owner's own browser.
    api.member("ada", "ada").await;
    assert_eq!(api.post("/api/phone/link", json!(null)).browser("steffen", true).send().await.status, 201);
}

#[tokio::test]
async fn a_sign_in_link_is_never_made_over_the_phones_port() {
    let api = TestApi::new().await;
    api.owner().await;
    for came in ["loopback, phone", "phone"] {
        let refused =
            api.post("/api/phone/link", json!(null)).browser("steffen", true).header("orrery-came", came).header("orrery-login-ways", "off").send().await;
        assert_eq!(refused.status, 403, "{}", refused.body);
    }
}

#[tokio::test]
async fn with_login_on_only_the_owners_own_browser_makes_a_sign_in_link() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "ada").await;
    let tries = [
        api.post("/api/phone/link", json!(null)),
        api.post("/api/phone/link", json!(null)).browser("ada", false),
        api.post("/api/phone/link", json!(null)).header("orrery-who", "agent").header("orrery-who-person", "steffen").header("orrery-who-owner", "1"),
        // Closed: nobody gets in, so nobody makes one.
        api.post("/api/phone/link", json!(null)).header("orrery-came", "").header("orrery-login-ways", "off"),
    ];
    for req in tries {
        let refused = req.send().await;
        assert_eq!(refused.status, 403, "{}", refused.body);
    }
}

#[tokio::test]
async fn a_session_the_chat_or_an_untrusted_one_never_makes_a_sign_in_link() {
    let api = TestApi::new().await;
    api.owner().await;
    for (kind, named) in [("session", "a session"), ("chat", "the owner's chat"), ("untrusted", "an untrusted session")] {
        // Even claiming the owner, and with login on even from the owner's browser.
        let off = api.post("/api/phone/link", json!(null)).header("orrery-actor-kind", kind).send().await;
        assert_eq!(off.status, 403, "{kind}: {}", off.body);
        assert_eq!(off.body["data"]["permission"], "phone.link");
        // The chat's and an untrusted session's rails refuse it at the door (ORR-1059), in their own words.
        let said = off.body["message"].as_str().unwrap();
        assert!(
            said.contains(&format!("refused for {named}"))
                || said.starts_with(&format!("This session {}", if kind == "chat" { "is the owner's chat" } else { "reads what others wrote" })),
            "{}",
            off.body
        );
        let on =
            api.post("/api/phone/link", json!(null)).browser("steffen", true).header("orrery-actor-kind", kind).header("orrery-login-ways", "on").send().await;
        assert_eq!(on.status, 403, "{kind}: {}", on.body);
    }
    let agent = api.post("/api/phone/link", json!(null)).by_agent("claude").send().await;
    assert_eq!(agent.status, 403);
    assert_eq!(agent.body["data"]["permission"], "phone.link");
}

#[tokio::test]
async fn a_sign_in_link_needs_the_owner_named() {
    let api = TestApi::new().await;
    let refused = api.post("/api/phone/link", json!(null)).send().await;
    assert_eq!(refused.status, 409, "{}", refused.body);
}

#[tokio::test]
async fn a_phones_link_signs_it_in_as_the_owner_once() {
    let api = TestApi::new().await;
    api.owner().await;
    let made = api.post("/api/phone/link", json!(null)).send().await;
    let token = made.body["token"].as_str().unwrap();
    let signed = api.post("/api/auth/link", json!({"token": token})).header("host", "192.168.1.4:9011").without("orrery-actor-owner").send().await;
    assert_eq!(signed.status, 201, "{}", signed.body);
    assert_eq!(signed.body, json!({"person": "steffen"}));
    assert!(signed.header("set-cookie").unwrap().starts_with("orrery_login_9011="));
    assert_eq!(logins(&api).await, [(hash(&cookie_secret(&signed)), "steffen".into(), None, Some(PHONE_LOGIN.into()))]);
    let again = api.post("/api/auth/link", json!({"token": token})).send().await;
    assert_eq!(again.status, 401, "{}", again.body);
    assert!(again.body["message"].as_str().unwrap().contains("sign-in link"));
    // Its code went with it.
    assert_eq!(api.post("/api/auth/link", json!({"code": made.body["code"]})).send().await.status, 401);
    assert_eq!(logins(&api).await.len(), 1);
}

#[tokio::test]
async fn a_typed_code_signs_a_phone_in_and_uses_up_its_link() {
    let api = TestApi::new().await;
    api.owner().await;
    let made = api.post("/api/phone/link", json!(null)).send().await;
    let code = made.body["code"].as_str().unwrap().to_lowercase();
    let typed = format!("{} {}", &code[..3], &code[3..]);
    let signed = api.post("/api/auth/link", json!({"code": typed})).send().await;
    assert_eq!(signed.status, 201, "{}", signed.body);
    assert_eq!(api.post("/api/auth/link", json!({"token": made.body["token"]})).send().await.status, 401);
    assert_eq!(api.post("/api/auth/link", json!({"code": typed})).send().await.status, 401);
}

#[tokio::test]
async fn a_link_run_out_or_never_made_signs_nobody_in() {
    let api = TestApi::new().await;
    api.owner().await;
    let old = api.app.phone.make("steffen", phone::now_ms() - (LINK_MINUTES * 60_000 + 1_000));
    for body in
        [json!({"token": old.token}), json!({"code": old.code}), json!({"token": "a".repeat(32)}), json!({}), json!({"token": 5}), json!({"code": "ABC"})]
    {
        let refused = api.post("/api/auth/link", body.clone()).send().await;
        assert_eq!(refused.status, 401, "{body}: {}", refused.body);
        assert!(refused.header("set-cookie").is_none());
    }
    let wrong = api.post("/api/auth/link", json!({"code": "ZZZZZZ"})).send().await;
    assert!(wrong.body["message"].as_str().unwrap().contains("code"), "{}", wrong.body);
    assert!(logins(&api).await.is_empty());
}

#[tokio::test]
async fn a_run_of_wrong_codes_ends_every_code_but_not_the_qr_links() {
    let api = TestApi::new().await;
    api.owner().await;
    let made = api.post("/api/phone/link", json!(null)).send().await;
    for _ in 0..WRONG_CODES {
        assert_eq!(api.post("/api/auth/link", json!({"code": "ZZZZZZ"})).send().await.status, 401);
    }
    assert_eq!(api.post("/api/auth/link", json!({"code": made.body["code"]})).send().await.status, 401);
    assert_eq!(api.post("/api/auth/link", json!({"token": made.body["token"]})).send().await.status, 201);
}

#[tokio::test]
async fn a_null_code_is_no_code_so_the_token_is_read() {
    let api = TestApi::new().await;
    api.owner().await;
    let made = api.post("/api/phone/link", json!(null)).send().await;
    assert_eq!(api.post("/api/auth/link", json!({"code": null, "token": made.body["token"]})).send().await.status, 201);
}

#[tokio::test]
async fn oidc_answers_only_with_a_provider_and_refuses_a_way_back_that_isnt_this_browsers() {
    let api = TestApi::new().await;
    // The provider's settings are the environment's, which every test shares: only this test sets them, and it
    // takes them out again.
    for name in ["NUXT_OIDC_ISSUER", "NUXT_OIDC_CLIENT_ID", "NUXT_OIDC_CLIENT_SECRET", "NUXT_ALLOWED_ORIGINS"] {
        std::env::remove_var(name);
    }
    assert_eq!(api.get("/api/auth/oidc/start").send().await.status, 404);
    assert_eq!(api.get("/api/auth/oidc/callback?state=a&code=b").send().await.status, 404);
    // An issuer that isn't on https, so nothing here is ever sent to it.
    std::env::set_var("NUXT_OIDC_ISSUER", "http://provider.example");
    std::env::set_var("NUXT_OIDC_CLIENT_ID", "orrery");
    std::env::set_var("NUXT_OIDC_CLIENT_SECRET", "a-secret");
    let kept = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
    let cleared = "orrery_oidc=; Max-Age=0; Path=/api/auth/oidc";
    let tries = [
        ("state=s&code=c", None),
        ("state=s&code=c", Some("not-what-start-kept!".to_string())),
        ("state=s&code=c", Some(kept(&json!("s")))),
        ("state=other&code=c", Some(kept(&json!({"state": "s"})))),
        ("state=s", Some(kept(&json!({"state": "s"})))),
        ("state=s&state=s&code=c", Some(kept(&json!({"state": "s"})))),
        ("code=c", Some(kept(&json!({})))),
    ];
    let mut answers = vec![];
    for (query, cookie) in tries {
        let mut req = api.get(&format!("/api/auth/oidc/callback?{query}"));
        if let Some(cookie) = &cookie {
            req = req.header("cookie", &format!("orrery_oidc={cookie}"));
        }
        let reply = req.send().await;
        answers.push((query, cookie.is_some(), reply.status.as_u16(), reply.header("set-cookie").map(str::to_owned), reply.header("location").is_some()));
    }
    let matched = api.get("/api/auth/oidc/callback?state=s&code=c").header("cookie", &format!("orrery_oidc={}", kept(&json!({"state": "s"})))).send().await;
    let started = api.get("/api/auth/oidc/start?invite=abc").send().await;
    for name in ["NUXT_OIDC_ISSUER", "NUXT_OIDC_CLIENT_ID", "NUXT_OIDC_CLIENT_SECRET"] {
        std::env::remove_var(name);
    }
    for (query, with_cookie, status, set_cookie, redirected) in answers {
        assert_eq!(status, 401, "{query} (cookie: {with_cookie})");
        assert_eq!(set_cookie.as_deref(), Some(cleared), "{query}: the kept cookie is cleared whatever comes of it");
        assert!(!redirected, "{query}");
    }
    // A way back that matches goes on to the provider, which has to be on https.
    assert_eq!(matched.status, 502, "{}", matched.body);
    assert_eq!(matched.header("set-cookie"), Some(cleared));
    assert_eq!(started.status, 502, "{}", started.body);
    assert!(started.header("set-cookie").is_none() && started.header("location").is_none());
    assert!(logins(&api).await.is_empty());
}
