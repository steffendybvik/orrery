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
    let package: Value = serde_json::from_str(include_str!("../../../web/package.json")).unwrap();
    assert_eq!(reply.body["result"]["serverInfo"]["version"], package["version"], "orrery's release version, not the crate's 0.0.0");
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
    assert!(names(&chat).contains(&"request".into()) && names(&chat).contains(&"reply".into()));
    assert!(!names(&chat).contains(&"start_issue".into()) && !names(&chat).contains(&"more_tools".into()));
    let untrusted = rpc(&api, "tools/list", json!({})).untrusted().send().await;
    assert!(names(&untrusted).contains(&"issue".into()));
    for refused in ["start_issue", "write_doc", "egress", "more_tools", "request", "github_issues"] {
        assert!(!names(&untrusted).contains(&refused.to_string()), "untrusted has {refused}");
    }
}

#[tokio::test]
async fn more_tools_adds_a_group_to_that_session_alone() {
    let api = TestApi::new().await;
    let (mine, other) = (session(&api).await, session(&api).await);
    let call = |id: &str, name: &str, args: Value| rpc(&api, "tools/call", json!({"name": name, "arguments": args})).header("mcp-session-id", id);
    let added = call(&mine, "more_tools", json!({"group": "secrets"})).send().await;
    assert_eq!(said(&added), "Added secrets to your tools.");
    let list = |id: &str| rpc(&api, "tools/list", json!({})).header("mcp-session-id", id);
    assert!(names(&list(&mine).send().await).contains(&"secrets".into()));
    assert!(!names(&list(&other).send().await).contains(&"secrets".into()));
    let wrong = call(&mine, "more_tools", json!({"group": "nope"})).send().await;
    assert_eq!(wrong.body["result"]["isError"], true);
    assert!(said(&wrong).starts_with("orrery said no: group is "));
    // Done with it, its groups are let go; a second goodbye finds nothing.
    assert_eq!(api.delete("/mcp").header("mcp-session-id", &mine).send().await.status, 204);
    assert!(!names(&list(&mine).send().await).contains(&"secrets".into()));
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
async fn a_tool_the_session_lacks_is_refused_and_the_channels_own_arent_here() {
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
    // What the channel keeps (ORR-1102) isn't here: the session has it from its channel.
    for own in ["start_issue", "egress", "link_folder", "sessions"] {
        assert_eq!(said(&call(own).send().await), format!("No tool \"{own}\""));
    }
}

#[tokio::test]
async fn every_tool_listed_is_served_here() {
    // Each tool is listed by the channel or by /mcp, never both (ORR-1102): what's listed here runs here, whatever it
    // makes of no arguments.
    let api = TestApi::new().await;
    api.project("alpha").await;
    let id = session(&api).await;
    for group in ["schedules", "secrets", "debug", "review", "epics"] {
        rpc(&api, "tools/call", json!({"name": "more_tools", "arguments": {"group": group}})).header("mcp-session-id", &id).send().await;
    }
    for kind in ["work", "chat", "untrusted"] {
        let listed =
            rpc(&api, "tools/list", json!({})).header("mcp-session-id", &id).header("orrery-actor-kind", kind).header("orrery-launch", "c1").send().await;
        for name in names(&listed) {
            let reply = rpc(&api, "tools/call", json!({"name": name, "arguments": {}}))
                .header("mcp-session-id", &id)
                .header("orrery-actor-kind", kind)
                .header("orrery-launch", "c1")
                .send()
                .await;
            assert!(!said(&reply).contains("isn't served at /mcp yet") && !said(&reply).starts_with("No tool"), "{kind}: {name}: {}", reply.body);
        }
    }
}

#[tokio::test]
async fn request_fields_says_what_a_chat_request_takes_as_the_channel_does() {
    let api = TestApi::new().await;
    let lists: Value = serde_json::from_str(include_str!("../../mcp-tools.json")).unwrap();
    let actions = lists["chat_requests"].as_array().expect("the chat's request actions");
    let call = |name: &str, args: Value| rpc(&api, "tools/call", json!({"name": name, "arguments": args})).header("orrery-actor-kind", "chat");
    let doc = actions.iter().find(|a| a["name"] == "create_doc").expect("create_doc is a request");
    let fields = call("request_fields", json!({"action": "create_doc"})).send().await;
    assert!(fields.body["result"]["isError"].is_null(), "{}", fields.body);
    let (head, schema) = said(&fields).split_once("\n\nfields: ").expect("its fields after a blank line");
    assert_eq!(head, format!("create_doc: {}", doc["description"].as_str().unwrap()));
    assert_eq!(serde_json::from_str::<Value>(schema).unwrap(), doc["inputSchema"]);
    // An action there isn't, to either tool, names those there are, in the channel's order.
    let names: Vec<&str> = actions.iter().map(|a| a["name"].as_str().unwrap()).collect();
    let none = format!("No action \"nope\": one of {}", names.join(", "));
    for name in ["request_fields", "request"] {
        let refused = call(name, json!({"action": "nope"})).send().await;
        assert_eq!((said(&refused), &refused.body["result"]["isError"]), (none.as_str(), &json!(true)), "{name}");
    }
    let unnamed = call("request_fields", json!({})).send().await;
    assert!(said(&unnamed).starts_with("No action \"undefined\": one of "), "{}", unnamed.body);
    // A work session has neither.
    let work = rpc(&api, "tools/call", json!({"name": "request_fields", "arguments": {"action": "create_doc"}})).send().await;
    assert_eq!(said(&work), "No tool \"request_fields\"");
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

/// A tool's call, as a work session sends it.
fn tool(api: &TestApi, name: &str, args: Value) -> Req {
    rpc(api, "tools/call", json!({"name": name, "arguments": args}))
}

#[tokio::test]
async fn write_doc_docs_and_doc_read_and_write_through_the_docs_routes() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    assert_eq!(said(&tool(&api, "docs", json!({})).send().await), "No docs yet.");
    let saved = tool(&api, "write_doc", json!({"id": "how-it-works", "title": "How it works", "body": "It turns.", "section": "Guides"})).send().await;
    assert_eq!(said(&saved), "Saved the doc how-it-works.", "{}", saved.body);
    let listed = said(&tool(&api, "docs", json!({})).send().await).to_string();
    assert!(listed.starts_with("how-it-works: How it works [Guides]"), "{listed}");
    assert_eq!(said(&tool(&api, "docs", json!({"q": "nothing-like-it"})).send().await), "No docs match.");
    assert_eq!(said(&tool(&api, "doc", json!({"id": "how-it-works"})).send().await), "# How it works\n\nIt turns.");
    let history = said(&tool(&api, "doc", json!({"id": "how-it-works", "history": true})).send().await).to_string();
    assert!(history.starts_with("1: How it works (owner, "), "{history}");
    let missing = tool(&api, "doc", json!({"id": "nope"})).send().await;
    assert_eq!(missing.body["result"]["isError"], true);
    assert!(said(&missing).starts_with("orrery said no: "), "{}", missing.body);
}

#[tokio::test]
async fn with_several_projects_a_board_tool_says_which_or_is_refused() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    api.project("beta").await;
    assert_eq!(said(&tool(&api, "docs", json!({})).send().await), "orrery said no: Say which project: alpha, beta");
    assert_eq!(said(&tool(&api, "docs", json!({"project": "gamma"})).send().await), "orrery said no: This server serves alpha, beta, not gamma");
    assert_eq!(said(&tool(&api, "docs", json!({"project": "beta"})).send().await), "No docs yet.");
}

#[tokio::test]
async fn an_untrusted_session_reads_docs_but_cant_write_one() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    assert_eq!(said(&tool(&api, "docs", json!({})).untrusted().send().await), "No docs yet.");
    assert_eq!(said(&tool(&api, "write_doc", json!({"id": "x", "title": "X", "body": "x"})).untrusted().send().await), "No tool \"write_doc\"");
}

#[tokio::test]
async fn presets_and_preset_read_the_projects_list() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let chat = |name: &str, args: Value| tool(&api, name, args).header("orrery-actor-kind", "chat");
    assert_eq!(said(&chat("presets", json!({})).send().await), "No presets yet; the owner makes them.");
    let made = api.post("/api/presets", json!({"name": "Careful", "text": "Run the tests first.\nThen ship."})).send().await;
    let id = made.body["id"].clone();
    let listed = said(&chat("presets", json!({})).send().await).to_string();
    assert_eq!(listed, format!("{}: Careful (the orrery's) — Run the tests first.", id.as_str().map(String::from).unwrap_or(id.to_string())));
    let one = said(&chat("preset", json!({"id": id})).send().await).to_string();
    assert!(one.starts_with("# Careful (the orrery's)\n\nWhat a session started with it is told"), "{one}");
    assert!(one.ends_with("Run the tests first.\nThen ship."));
    assert_eq!(said(&chat("preset", json!({"id": "nope"})).send().await), "No preset nope for this project; presets lists them.");
}

#[tokio::test]
async fn milestones_are_made_changed_and_listed_through_their_routes() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    // Milestones are the chat's to plan with.
    let list = || tool(&api, "milestones", json!({})).header("orrery-actor-kind", "chat");
    assert_eq!(said(&list().send().await), "No milestones yet.");
    let made = said(&tool(&api, "create_milestone", json!({"title": "Launch", "priority": "P1"})).header("orrery-actor-kind", "chat").send().await).to_string();
    assert!(made.starts_with("Made milestone ") && made.ends_with("\")."), "{made}");
    let id = made.trim_start_matches("Made milestone ").split(':').next().unwrap().to_string();
    let listed = said(&list().send().await).to_string();
    assert!(listed.starts_with(&format!("{id} [")) && listed.contains(", P1] Launch: 0/0 done"), "{listed}");
    let changed = said(&tool(&api, "update_milestone", json!({"id": id, "title": "Lift-off"})).header("orrery-actor-kind", "chat").send().await).to_string();
    assert_eq!(changed, format!("Milestone {id} is now: Lift-off"));
}

#[tokio::test]
async fn releases_say_none_yet_and_a_new_one_with_its_count() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    assert_eq!(said(&tool(&api, "releases", json!({})).send().await), "No releases yet.");
    api.patch("/api/projects/alpha", json!({"release_mode": "own"})).send().await;
    let made = api.post("/api/projects/alpha/releases", json!({"version": "1.0.0"})).send().await;
    assert!(made.status.is_success(), "{}", made.body);
    assert_eq!(said(&tool(&api, "releases", json!({})).send().await), "1.0.0: 0 issues, 0/0 done");
}

#[tokio::test]
async fn epics_are_made_changed_and_listed() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let chat = |name: &str, args: Value| tool(&api, name, args).header("orrery-actor-kind", "chat");
    assert_eq!(said(&chat("epics", json!({})).send().await), "No epics yet.");
    let made = said(&tool(&api, "create_epic", json!({"title": "Big thing"})).send().await).to_string();
    assert!(made.starts_with("Made epic ") && made.ends_with(". Set epic: 1 on each issue in it."), "{made}");
    assert_eq!(said(&tool(&api, "update_epic", json!({"id": "1", "title": "Bigger"})).send().await), "Epic 1 is now: Bigger");
    assert_eq!(said(&chat("epics", json!({})).send().await), "1 Bigger: 0 issues, 0/0 done");
}

#[tokio::test]
async fn issues_are_made_listed_changed_and_commented_on_through_their_routes() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    assert_eq!(said(&tool(&api, "issues", json!({})).send().await), "No issues match.");
    let made = said(&tool(&api, "create_issue", json!({"title": "Sieve", "status": "todo", "priority": "P1"})).send().await).to_string();
    assert!(made.starts_with("Made ") && made.ends_with(" [todo, P1] Sieve"), "{made}");
    let id = made.trim_start_matches("Made ").split(' ').next().unwrap().to_string();
    assert_eq!(said(&tool(&api, "issues", json!({})).send().await), format!("{id} [todo, P1] Sieve"));
    let changed = said(&tool(&api, "update_issue", json!({"id": id, "assignee": "claude"})).send().await).to_string();
    assert_eq!(changed, format!("Now {id} [todo, P1, claude] Sieve"));
    let edited = said(&tool(&api, "edit_issue", json!({"id": id, "title": "Wheel"})).header("orrery-actor-kind", "chat").send().await).to_string();
    assert_eq!(edited, format!("Now {id} [todo, P1, claude] Wheel"));
    let commented = said(&tool(&api, "comment", json!({"id": id, "body": "On it.", "asks": "decision"})).send().await).to_string();
    assert!(commented.starts_with(&format!("Commented on {id} (comment ")) && commented.ends_with("), asking the owner for a decision."), "{commented}");
    let plain = said(&tool(&api, "comment", json!({"id": id, "body": "Done."})).send().await).to_string();
    assert!(plain.ends_with(")."), "{plain}");
}

#[tokio::test]
async fn a_work_sessions_list_leaves_out_backlog_and_finished_issues_but_says_so() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.issue(&project, json!({"title": "Someday"})).await;
    api.issue(&project, json!({"title": "Shipped", "status": "done"})).await;
    assert_eq!(said(&tool(&api, "issues", json!({})).send().await), "No issues match.\n1 in backlog not shown: status: backlog lists them");
    let chat = said(&tool(&api, "issues", json!({})).header("orrery-actor-kind", "chat").send().await).to_string();
    assert!(chat.ends_with("[backlog] Someday"), "the chat keeps backlog: {chat}");
    let every = said(&tool(&api, "issues", json!({"open": false})).send().await).to_string();
    assert!(every.contains("Shipped") && every.contains("Someday"), "{every}");
    let done = said(&tool(&api, "issues", json!({"status": "done"})).send().await).to_string();
    assert!(done.ends_with("[done] Shipped"), "{done}");
}

#[tokio::test]
async fn a_search_says_where_it_found_a_word_but_never_quotes_it_to_an_untrusted_session() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.issue(&project, json!({"title": "Sieve", "status": "todo", "notes": "Find the primes below a million."})).await;
    let found = said(&tool(&api, "issues", json!({"q": "million"})).send().await).to_string();
    assert!(found.contains("\n    in its description: "), "{found}");
    let untrusted = said(&tool(&api, "issues", json!({"q": "million"})).untrusted().send().await).to_string();
    assert!(untrusted.ends_with("\n    in its description"), "{untrusted}");
}

#[tokio::test]
async fn with_several_projects_an_issues_id_says_which() {
    let api = TestApi::new().await;
    let alpha = api.project("alpha").await;
    api.project("beta").await;
    let id = api.issue(&alpha, json!({"title": "Sieve", "status": "todo"})).await;
    let changed = said(&tool(&api, "update_issue", json!({"id": id, "priority": "P2"})).send().await).to_string();
    assert_eq!(changed, format!("Now {id} [todo, P2] Sieve"));
    let stranger = said(&tool(&api, "comment", json!({"id": "ZZZ-1", "body": "Hi"})).send().await).to_string();
    assert_eq!(stranger, "orrery said no: ZZZ-1 isn't an issue of alpha, beta: its key is none of theirs");
    let unnamed = said(&tool(&api, "create_issue", json!({"title": "Where?"})).send().await).to_string();
    assert_eq!(unnamed, "orrery said no: Say which project: alpha, beta");
}

#[tokio::test]
async fn comment_epic_posts_on_the_epic() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    tool(&api, "create_epic", json!({"title": "Big thing"})).send().await;
    let commented = said(&tool(&api, "comment_epic", json!({"id": "1", "body": "Going well."})).send().await).to_string();
    assert!(commented.starts_with("Commented on epic 1 (comment ") && commented.ends_with(")."), "{commented}");
}

#[tokio::test]
async fn rate_pull_reads_the_pr_as_the_channel_does_and_asks_its_route() {
    let api = TestApi::new().await;
    let (_, issue) = api.board().await;
    let rate = |pull: Value| tool(&api, "rate_pull", json!({"id": issue, "pull": pull, "level": "high", "why": "touches signals"}));
    // No PR is kept here, so the route refuses: what it names shows the link was read as the channel reads it.
    let refused = said(&rate(json!("https://github.com/ada/primes/pull/12")).send().await).to_string();
    assert!(refused.starts_with(&format!("orrery said no: orrery keeps no pull request #12 on ada/primes for {issue}")), "{refused}");
    assert_eq!(said(&rate(json!("ada/primes#12")).send().await), refused);
    assert_eq!(said(&rate(json!("twelve")).send().await), "Give the PR as owner/name#number or its link, not \"twelve\"");
}

#[tokio::test]
async fn what_a_tools_routes_set_off_comes_back_on_the_mcp_reply_for_the_router_to_pass_on() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let made = tool(&api, "create_issue", json!({"title": "Down", "status": "todo", "priority": "P0"})).send().await;
    let id = said(&made).trim_start_matches("Made ").split(' ').next().unwrap().to_string();
    assert_eq!(made.said("orrery-urgent"), [format!("alpha {id}")], "the push to the sessions is the router's");
    assert_eq!(made.header("orrery-changed"), Some("alpha"));
    let asked = tool(&api, "comment", json!({"id": id, "body": "Which way?", "asks": "decision"})).send().await;
    assert_eq!(asked.said("orrery-carry"), [format!("alpha {id} 1")], "passing it on to the session is the router's");
    assert_eq!(asked.told(), [format!("comment.asks alpha {id} ~ decision")]);
    let read = tool(&api, "issue", json!({"id": id})).send().await;
    assert_eq!(read.header("orrery-carry"), None, "a read sets nothing off");
    assert_eq!(read.header("orrery-changed"), None);
}

#[tokio::test]
async fn the_chats_and_an_untrusted_sessions_tool_calls_are_held_by_the_rails() {
    // The router lets their `/mcp` through (ORR-1102): each tool's route is held here as middleware/chat.ts and
    // untrusted.ts hold the REST routes.
    let api = TestApi::new().await;
    let own = api.project("Primes").await;
    let other = api.project("Sieves").await;
    let id = api.issue(&own, json!({"title": "Sieve"})).await;
    let call = |name: &str, args: Value| rpc(&api, "tools/call", json!({"name": name, "arguments": args}));

    let untrusted = |req: Req| req.untrusted().header("orrery-untrusted-project", &own);
    let comment = untrusted(call("comment", json!({"id": id, "body": "Hi"}))).send().await;
    assert_eq!(comment.body["result"]["isError"], json!(true), "a comment on the owner's issue: {}", comment.body);
    let elsewhere = untrusted(call("create_issue", json!({"project": other, "title": "From outside"}))).send().await;
    assert!(said(&elsewhere).contains(&format!("for {own}, so it only writes there")), "{}", elsewhere.body);
    let raised = untrusted(call("create_issue", json!({"project": own, "title": "From outside"}))).send().await;
    assert_ne!(raised.body["result"]["isError"], json!(true), "{}", raised.body);

    let chat = |req: Req| req.by_agent("claude").header("orrery-actor-asked", "1").header("orrery-actor-kind", "chat");
    let made = chat(call("create_issue", json!({"project": own, "title": "Wheel"}))).send().await;
    assert_ne!(made.body["result"]["isError"], json!(true), "{}", made.body);
    let doc = chat(call("write_doc", json!({"project": own, "id": "notes", "title": "Notes", "body": "x"}))).send().await;
    assert_ne!(doc.body["result"]["isError"], json!(true), "the chat writes docs: {}", doc.body);
}
