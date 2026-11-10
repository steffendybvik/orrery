// The tests of routes/mcp.rs (ORR-1098), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{Reply, Req, TestApi};
use serde_json::{json, Value};

fn rpc(api: &TestApi, method: &str, params: Value) -> Req {
    api.post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
}

fn names(reply: &Reply) -> Vec<String> {
    reply.body["result"]["tools"].as_array().expect("a tool list").iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
}

fn said(reply: &Reply) -> &str {
    reply.body["result"]["content"][0]["text"].as_str().expect("a text answer")
}

/// A new MCP session's id, from `initialize`.
async fn session(api: &TestApi) -> String {
    let reply =
        rpc(api, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.header("mcp-session-id").expect("a session id").to_string()
}

#[tokio::test]
async fn initialize_says_its_version_and_tools_and_starts_a_session() {
    let api = TestApi::new().await;
    let reply = rpc(&api, "initialize", json!({"protocolVersion": "2025-03-26"})).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body["jsonrpc"], "2.0");
    assert_eq!(reply.body["id"], 1);
    assert_eq!(reply.body["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(reply.body["result"]["serverInfo"]["name"], "orrery");
    assert!(reply.body["result"]["capabilities"]["tools"].is_object());
    assert_eq!(reply.header("mcp-session-id").map(str::len), Some(32));
    let unknown = rpc(&api, "initialize", json!({"protocolVersion": "1999-01-01"})).send().await;
    assert_eq!(unknown.body["result"]["protocolVersion"], crate::mcp::VERSIONS[0], "a version it doesn't speak gets its newest");
}

#[tokio::test]
async fn a_notification_gets_202_and_no_body_and_ping_an_empty_result() {
    let api = TestApi::new().await;
    let note = api.post("/mcp", json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).send().await;
    assert_eq!(note.status, 202);
    assert_eq!(note.body, Value::Null);
    let ping = rpc(&api, "ping", json!({})).send().await;
    assert_eq!(ping.body["result"], json!({}));
}

#[tokio::test]
async fn a_batch_is_answered_in_one_list_leaving_out_its_notifications() {
    let api = TestApi::new().await;
    let reply = api
        .post("/mcp", json!([{"jsonrpc": "2.0", "id": "a", "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}, {"jsonrpc": "2.0", "id": "b", "method": "ping"}]))
        .send()
        .await;
    assert_eq!(reply.status, 200);
    let ids: Vec<&Value> = reply.body.as_array().unwrap().iter().map(|a| &a["id"]).collect();
    assert_eq!(ids, [&json!("a"), &json!("b")]);
}

#[tokio::test]
async fn what_isnt_json_or_a_method_it_has_gets_json_rpcs_errors() {
    let api = TestApi::new().await;
    let reply = rpc(&api, "resources/list", json!({})).send().await;
    assert_eq!(reply.body["error"]["code"], -32601);
    let nameless = rpc(&api, "tools/call", json!({})).send().await;
    assert_eq!(nameless.body["error"]["code"], -32602);
    let no_method = api.post("/mcp", json!({"jsonrpc": "2.0", "id": 3})).send().await;
    assert_eq!(no_method.body["error"]["code"], -32600);
}

#[tokio::test]
async fn a_work_sessions_list_names_the_project_only_once_there_are_several() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let one = rpc(&api, "tools/list", json!({})).send().await;
    let issues = |reply: &Reply| reply.body["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "issues").unwrap().clone();
    assert!(issues(&one)["inputSchema"]["properties"].get("project").is_none());
    assert!(names(&one).contains(&"more_tools".into()));
    assert!(!names(&one).contains(&"milestones".into()), "the chat's reads aren't a work session's");
    api.project("beta").await;
    let two = rpc(&api, "tools/list", json!({})).send().await;
    assert_eq!(issues(&two)["inputSchema"]["properties"]["project"]["enum"], json!(["alpha", "beta"]));
    assert_eq!(issues(&two)["inputSchema"]["required"][0], "project");
}

#[tokio::test]
async fn the_chat_and_an_untrusted_session_get_their_own_lists() {
    let api = TestApi::new().await;
    let chat = rpc(&api, "tools/list", json!({})).header("orrery-actor-kind", "chat").send().await;
    assert!(names(&chat).contains(&"request".into()) && names(&chat).contains(&"github_pulls".into()));
    assert!(!names(&chat).contains(&"start_issue".into()) && !names(&chat).contains(&"more_tools".into()));
    let untrusted = rpc(&api, "tools/list", json!({})).untrusted().send().await;
    assert!(names(&untrusted).contains(&"github_issues".into()));
    for refused in ["start_issue", "write_doc", "egress", "more_tools", "request"] {
        assert!(!names(&untrusted).contains(&refused.to_string()), "untrusted has {refused}");
    }
}

#[tokio::test]
async fn more_tools_adds_a_group_to_that_session_alone() {
    let api = TestApi::new().await;
    let (mine, other) = (session(&api).await, session(&api).await);
    let call = |id: &str, name: &str, args: Value| rpc(&api, "tools/call", json!({"name": name, "arguments": args})).header("mcp-session-id", id);
    let added = call(&mine, "more_tools", json!({"group": "secrets"})).send().await;
    assert_eq!(said(&added), "Added secrets, egress to your tools.");
    let list = |id: &str| rpc(&api, "tools/list", json!({})).header("mcp-session-id", id);
    assert!(names(&list(&mine).send().await).contains(&"egress".into()));
    assert!(!names(&list(&other).send().await).contains(&"egress".into()));
    let wrong = call(&mine, "more_tools", json!({"group": "nope"})).send().await;
    assert_eq!(wrong.body["result"]["isError"], true);
    assert!(said(&wrong).starts_with("orrery said no: group is "));
    // Done with it, its groups are let go; a second goodbye finds nothing.
    assert_eq!(api.delete("/mcp").header("mcp-session-id", &mine).send().await.status, 204);
    assert!(!names(&list(&mine).send().await).contains(&"egress".into()));
    assert_eq!(api.delete("/mcp").header("mcp-session-id", &mine).send().await.status, 404);
    assert_eq!(api.delete("/mcp").send().await.status, 400);
}

#[tokio::test]
async fn guide_gives_its_contents_or_one_section() {
    let api = TestApi::new().await;
    let call = |args: Value| rpc(&api, "tools/call", json!({"name": "guide", "arguments": args}));
    let contents = call(json!({})).send().await;
    assert!(said(&contents).contains("## Contents"), "{}", contents.body);
    let missing = call(json!({"section": "no such thing at all"})).send().await;
    assert!(said(&missing).starts_with("No section or page called"));
    for kind in ["chat", "untrusted"] {
        let reply = call(json!({})).header("orrery-actor-kind", kind).send().await;
        assert!(said(&reply).contains("## Contents"), "{kind} reads the guide");
    }
}

#[tokio::test]
async fn a_tool_the_session_lacks_is_refused_and_one_not_moved_yet_says_so() {
    let api = TestApi::new().await;
    let call = |name: &str| rpc(&api, "tools/call", json!({"name": name, "arguments": {}}));
    let unknown = call("nope").send().await;
    assert_eq!((said(&unknown), &unknown.body["result"]["isError"]), ("No tool \"nope\"", &json!(true)));
    let chat_only = call("request").send().await;
    assert_eq!(said(&chat_only), "No tool \"request\"");
    let untrusted = call("start_issue").untrusted().send().await;
    assert_eq!(said(&untrusted), "No tool \"start_issue\"");
    let chat_more = call("more_tools").header("orrery-actor-kind", "chat").send().await;
    assert_eq!(said(&chat_more), "No tool \"more_tools\"");
    let later = call("issues").send().await;
    assert!(said(&later).contains("isn't served at /mcp yet"), "{}", later.body);
}

#[tokio::test]
async fn get_has_no_stream() {
    let api = TestApi::new().await;
    let reply = api.get("/mcp").send().await;
    assert_eq!(reply.status, 405);
    assert_eq!(reply.header("allow"), Some("POST, DELETE"));
}

#[tokio::test]
async fn json_that_isnt_a_message_is_an_invalid_request() {
    let api = TestApi::new().await;
    let reply = api.post("/mcp", json!("x")).send().await;
    assert_eq!(reply.body["error"]["code"], -32600);
}

/// A door-facing orrery with an owner and a member, so login is on.
async fn login_on() -> TestApi {
    let api = TestApi::at_the_door().await;
    api.owner().await;
    api.member("ada", "ada").await;
    sqlx::query("INSERT INTO settings (key, value) VALUES ('auth_on', 'true')").execute(&api.app.pool).await.unwrap();
    api
}

#[tokio::test]
async fn with_login_on_an_agent_key_gets_the_tools_and_a_login_or_nothing_doesnt() {
    let api = login_on().await;
    api.key("steffen", "person").await;
    let agent = api.key("ada", "agent").await;
    let keyed = rpc(&api, "tools/list", json!({})).header("orrery-key", &agent).send().await;
    assert_eq!(keyed.status, 200, "{}", keyed.body);
    assert!(names(&keyed).contains(&"guide".into()));
    assert_eq!(rpc(&api, "tools/list", json!({})).send().await.status, 401);
    let login = api.login("ada").await;
    let browser = rpc(&api, "tools/list", json!({})).signed_in(&login).send().await;
    assert_eq!(browser.status, 403, "{}", browser.body);
    assert!(browser.body["message"].as_str().unwrap().contains("for agents"));
    assert_eq!(api.get("/mcp").signed_in(&login).send().await.status, 403);
}

#[tokio::test]
async fn without_the_routers_token_mcp_is_refused_as_every_route_is() {
    let api = TestApi::new().await;
    let reply = rpc(&api, "ping", json!({})).without("orrery-api-token").send().await;
    assert_eq!(reply.status, 401);
}
