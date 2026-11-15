// The tests of the event log's, the secrets' and the chat's image tools at `/mcp` (machine.rs), through `router()` on a
// database of their own.
use crate::testing::{Req, TestApi};
use serde_json::{json, Value};

fn call(api: &TestApi, name: &str, args: Value) -> Req {
    api.post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}))
}

fn said(reply: &crate::testing::Reply) -> &str {
    reply.body["result"]["content"][0]["text"].as_str().expect("a text answer")
}

/// A line in the log, last seen at `at`, with its `details` (JSON) when given; its id.
async fn line(api: &TestApi, level: &str, kind: &str, project: &str, message: &str, at: &str, details: &str) -> i64 {
    api.run(
        "INSERT INTO events (level, kind, project, message, details, count, first_seen, last_seen) VALUES (?, ?, nullif(?, ''), ?, nullif(?, ''), 1, ?, ?)",
        &[level, kind, project, message, details, at, at],
    )
    .await;
    api.count("SELECT max(id) FROM events").await
}

#[tokio::test]
async fn events_says_when_the_log_has_nothing_for_it() {
    let api = TestApi::new().await;
    let reply = call(&api, "events", json!({})).send().await;
    assert_eq!(said(&reply), "Nothing in the event log for that.", "{}", reply.body);
}

#[tokio::test]
async fn events_are_a_line_each_newest_first_as_the_channel_writes_them() {
    let api = TestApi::new().await;
    line(&api, "error", "server.error", "", "Boom", "2026-11-10T10:00:00.000Z", "").await;
    line(&api, "error", "page.error", "primes", "Oops", "2026-11-10T10:01:00.000Z", r#"{"reported":true}"#).await;
    api.run("UPDATE events SET count = 3 WHERE kind = 'server.error'", &[]).await;
    let reply = call(&api, "events", json!({})).send().await;
    assert_eq!(
        said(&reply),
        "#2 [error] page.error (reported by a page: anyone can send one, so not checked) (primes), last 2026-11-10T10:01:00.000Z: Oops\n\
         #1 [error] server.error ×3, last 2026-11-10T10:00:00.000Z: Boom"
    );
}

#[tokio::test]
async fn events_filters_as_the_route_does_and_details_adds_them() {
    let api = TestApi::new().await;
    line(&api, "error", "server.error", "", "Boom", "2026-11-10T10:00:00.000Z", r#"{"route":"/api/x","stack":"at y"}"#).await;
    line(&api, "info", "session.started", "primes", "Started", "2026-11-10T10:01:00.000Z", "").await;
    let errors = call(&api, "events", json!({"level": "error", "details": true, "open": true, "kind": ""})).send().await;
    assert_eq!(said(&errors), "#1 [error] server.error, last 2026-11-10T10:00:00.000Z: Boom\n{\n  \"route\": \"/api/x\",\n  \"stack\": \"at y\"\n}");
    let limited = call(&api, "events", json!({"limit": 1})).send().await;
    assert_eq!(said(&limited), "#2 [info] session.started (primes), last 2026-11-10T10:01:00.000Z: Started");
    let on = call(&api, "events", json!({"project": "primes", "open": false})).send().await;
    assert!(said(&on).starts_with("#2 ") && !said(&on).contains("#1 "), "{}", said(&on));
}

#[tokio::test]
async fn resolve_event_marks_a_line_dealt_with_by_whoever_asked() {
    let api = TestApi::new().await;
    let id = line(&api, "error", "server.error", "", "Boom", "2026-11-10T10:00:00.000Z", "").await;
    let reply = call(&api, "resolve_event", json!({"id": id})).by_agent("claude").send().await;
    assert_eq!(said(&reply), "Resolved #1 server.error: Boom", "{}", reply.body);
    let listed = call(&api, "events", json!({})).send().await;
    assert_eq!(said(&listed), "#1 [error] server.error, last 2026-11-10T10:00:00.000Z, resolved by claude: Boom");
    assert_eq!(api.outbox().await.iter().filter(|c| c.kind == "event.logged").count(), 1, "open pages hear it");
}

#[tokio::test]
async fn resolve_event_on_no_line_says_no() {
    let api = TestApi::new().await;
    let reply = call(&api, "resolve_event", json!({"id": 99})).send().await;
    assert_eq!(reply.body["result"]["isError"], true);
    assert!(said(&reply).starts_with("orrery said no: "), "{}", said(&reply));
}

#[tokio::test]
async fn secrets_lists_each_with_its_hosts_and_never_a_value() {
    let api = TestApi::new().await;
    let none = call(&api, "secrets", json!({})).send().await;
    assert_eq!(said(&none), "No secrets yet; the owner sets them on App settings.");
    for (name, hosts, projects) in
        [("STRIPE_KEY", r#"["api.stripe.com"]"#, r#"["shop","primes"]"#), ("GITHUB_TOKEN", r#"["api.github.com","uploads.github.com"]"#, "")]
    {
        api.run(
            "INSERT INTO secrets (name, value, last4, hosts, projects, created_by, owned, created_at, updated_at) \
             VALUES (?, 'sealed-value', 'wxyz', ?, nullif(?, ''), 'owner', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')",
            &[name, hosts, projects],
        )
        .await;
    }
    let listed = call(&api, "secrets", json!({})).send().await;
    assert_eq!(said(&listed), "GITHUB_TOKEN → api.github.com, uploads.github.com\nSTRIPE_KEY → api.stripe.com (only shop, primes)");
    assert!(!listed.body.to_string().contains("sealed-value"));
}

#[tokio::test]
async fn an_untrusted_session_has_neither_the_log_nor_the_secrets() {
    let api = TestApi::new().await;
    for name in ["events", "resolve_event", "secrets", "image"] {
        let reply = call(&api, name, json!({})).untrusted().send().await;
        assert_eq!(said(&reply), format!("No tool \"{name}\""));
    }
}

#[tokio::test]
async fn image_gives_the_chat_its_pasted_image_as_itself() {
    let api = TestApi::new().await;
    let id = "0123456789abcdef01234567";
    sqlx::query(&crate::db::sql("INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"))
        .bind(id)
        .bind("image/webp")
        .bind("dot.webp")
        .bind(3_i64)
        .bind(b"abc".to_vec())
        .bind("owner")
        .bind(1_i64)
        .bind("2026-11-07T00:00:00.000Z")
        .execute(&api.app.pool)
        .await
        .unwrap();
    let reply = call(&api, "image", json!({"id": id})).header("orrery-actor-kind", "chat").send().await;
    assert_eq!(reply.body["result"], json!({"content": [{"type": "image", "data": "YWJj", "mimeType": "image/webp"}]}));
    let work = call(&api, "image", json!({"id": id})).send().await;
    assert_eq!(said(&work), "No tool \"image\"", "only the chat has it");
}

#[tokio::test]
async fn image_refuses_what_isnt_an_upload_id_and_one_not_kept() {
    let api = TestApi::new().await;
    let chat = |id: Value| call(&api, "image", json!({"id": id})).header("orrery-actor-kind", "chat");
    let shaped = chat(json!("../secrets")).send().await;
    assert_eq!((said(&shaped), &shaped.body["result"]["isError"]), ("orrery said no: ../secrets isn't an upload's id", &json!(true)));
    let upper = chat(json!("0123456789ABCDEF01234567")).send().await;
    assert_eq!(said(&upper), "orrery said no: 0123456789ABCDEF01234567 isn't an upload's id");
    let missing = chat(json!("fedcba9876543210fedcba98")).send().await;
    assert_eq!(said(&missing), "orrery said no: 404 Not Found");
}
