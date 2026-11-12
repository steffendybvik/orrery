// The tests of the `schedules` tool at `/mcp` (schedules.rs), through `router()` on a database of their own.
use crate::testing::{Reply, TestApi};
use serde_json::{json, Value};

async fn call(api: &TestApi, args: Value) -> Reply {
    api.post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "schedules", "arguments": args}}))
        .header("orrery-actor-kind", "chat")
        .send()
        .await
}

fn said(reply: &Reply) -> &str {
    reply.body["result"]["content"][0]["text"].as_str().expect("a text answer")
}

/// Puts a schedule on `project` with SQL, as there's no write route yet: its `columns` and their SQL values.
async fn schedule(api: &TestApi, project: &str, columns: &[(&str, &str)]) -> i64 {
    let mut all = vec![
        ("project", format!("'{project}'")),
        ("created_by", "'owner'".into()),
        ("created_at", "'2026-11-01T00:00:00.000Z'".into()),
        ("updated_at", "'2026-11-01T00:00:00.000Z'".into()),
    ];
    all.extend(columns.iter().map(|(c, v)| (*c, v.to_string())));
    let query = format!(
        "INSERT INTO schedules ({}) VALUES ({}) RETURNING id",
        all.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(", "),
        all.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(", ")
    );
    sqlx::query_scalar::<_, i64>(&query).fetch_one(&api.app.pool).await.unwrap()
}

#[tokio::test]
async fn no_schedules_says_so() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    assert_eq!(said(&call(&api, json!({})).await), "No schedules yet.");
}

#[tokio::test]
async fn each_schedule_is_a_line_as_the_channel_writes_it() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let weekly = schedule(
        &api,
        "alpha",
        &[("title", "'Weekly review'"), ("cron", "'0 9 * * 1'"), ("timezone", "'Europe/Oslo'"), ("next_run", "'2026-11-16T08:00:00.000Z'")],
    )
    .await;
    sqlx::query(&crate::db::sql("INSERT INTO schedule_runs (schedule, at, outcome, issue, note) VALUES (?, ?, ?, ?, ?)"))
        .bind(weekly)
        .bind("2026-11-09T08:00:00.000Z")
        .bind("made")
        .bind("ALP-1")
        .bind("first")
        .execute(&api.app.pool)
        .await
        .unwrap();
    let on = schedule(
        &api,
        "alpha",
        &[("title", "'On done'"), ("on_event", "'issue.status'"), ("on_filter", "'{\"to\":\"done\"}'"), ("timezone", "'UTC'"), ("enabled", "0")],
    )
    .await;
    let said = said(&call(&api, json!({})).await).to_string();
    let lines: Vec<&str> = said.lines().collect();
    assert!(
        lines.contains(
            &format!(
                "{weekly}: Weekly review [issue, on] 0 9 * * 1 (Europe/Oslo); last 2026-11-09T08:00:00.000Z made ALP-1 (first); next 2026-11-16T08:00:00.000Z"
            )
            .as_str()
        ),
        "{said}"
    );
    assert!(lines.contains(&format!("{on}: On done [issue, paused] on issue.status {{\"to\":\"done\"}}; never run").as_str()), "{said}");
    assert_eq!(lines.len(), 2);
}

#[tokio::test]
async fn a_work_session_doesnt_have_it() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let reply = api.post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "schedules", "arguments": {}}})).send().await;
    assert_eq!(reply.body["result"]["isError"], true);
    assert_eq!(said(&reply), "No tool \"schedules\"");
}

fn ask(name: &str, args: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
}

#[tokio::test]
async fn a_work_session_asks_on_its_issue() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let schedule = json!({"title": "Nudge", "kind": "message", "notes": "Hi", "cron": "0 9 * * 1"});
    let reply = api.post("/mcp", ask("create_schedule", json!({"id": issue, "schedule": schedule, "why": "You asked"}))).by_agent("claude").send().await;
    assert_ne!(reply.body["result"]["isError"], true, "{}", reply.body);
    let comment = api.get(&format!("/api/projects/{project}/issues/{issue}/comments")).send().await.body[0].clone();
    assert_eq!(
        said(&reply),
        format!("Asked on {issue} (comment {}): the owner sees the schedule with Allow and Deny, and their answer comes back as a comment. Nothing is saved until they allow it.", comment["id"])
    );
    assert_eq!(comment["schedule"]["title"], "Nudge");
    let id = schedule_id(&api, &project).await;
    let reply =
        api.post("/mcp", ask("update_schedule", json!({"id": issue, "schedule_id": id, "schedule": {"enabled": false}}))).by_agent("claude").send().await;
    assert!(said(&reply).contains("the owner sees the change with Allow and Deny"), "{}", reply.body);
    let comments = api.get(&format!("/api/projects/{project}/issues/{issue}/comments")).send().await.body;
    assert_eq!(comments[1]["schedule"]["id"], id);
}

async fn schedule_id(api: &TestApi, project: &str) -> i64 {
    schedule(api, project, &[("title", "'Nightly'"), ("kind", "'message'"), ("notes", "'Hi'"), ("cron", "'0 2 * * *'"), ("timezone", "'UTC'")]).await
}

#[tokio::test]
async fn the_chats_asks_stay_with_its_channel() {
    let api = TestApi::new().await;
    let (_, issue) = api.board().await;
    let reply = api.post("/mcp", ask("create_schedule", json!({"title": "Nudge", "cron": "0 9 * * 1"}))).header("orrery-actor-kind", "chat").send().await;
    assert_eq!(reply.body["result"]["isError"], true);
    // Not asked on an issue: the chat's tools ask in its chat, which its channel keeps.
    assert!(!said(&reply).starts_with("Asked"), "{}", reply.body);
    assert_eq!(api.get(&format!("/api/projects/primes/issues/{issue}/comments")).send().await.body, json!([]));
}

/// The chat's `request` for `update_settings` with `fields`, as the channel's `callTool` takes it, from the chat `launch`.
async fn ask_setting(api: &TestApi, launch: Option<&str>, mut fields: Value) -> Reply {
    let why = fields.as_object_mut().and_then(|f| f.remove("why"));
    let mut args = json!({"action": "update_settings", "fields": fields});
    if let Some(why) = why {
        args["why"] = why;
    }
    let request = api
        .post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "request", "arguments": args}}))
        .header("orrery-actor-kind", "chat");
    match launch {
        Some(launch) => request.header("orrery-launch", launch),
        None => request,
    }
    .send()
    .await
}

#[tokio::test]
async fn the_chats_update_settings_is_asked_in_its_chat_and_saves_nothing() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.put("/api/chats/c1", json!({"id": "c1", "project": project, "started_at": "2026-11-01T10:00:00.000Z"})).send().await;
    let reply = ask_setting(&api, Some("c1"), json!({"setting": "tint", "value": "blue", "why": "Brighter"})).await;
    assert_eq!(said(&reply), "Asked: the owner sees it with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it.");
    let messages = api.get("/api/chats/c1").send().await.body["messages"].clone();
    assert_eq!(messages[0]["text"], "Brighter");
    assert_eq!(messages[0]["request"], json!({"setting": "tint", "from": null, "to": "blue", "state": "asked"}));
    assert!(api.get("/api/settings").send().await.body["tint"].is_null());
}

#[tokio::test]
async fn the_chats_update_settings_says_no_to_what_the_settings_refuse_and_with_no_chat_named() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.put("/api/chats/c1", json!({"id": "c1", "project": project, "started_at": "2026-11-01T10:00:00.000Z"})).send().await;
    let refused = ask_setting(&api, Some("c1"), json!({"setting": "instructions", "value": []})).await;
    assert!(said(&refused).starts_with("orrery said no: "), "{}", refused.body);
    let nameless = ask_setting(&api, None, json!({"setting": "tint", "value": "blue"})).await;
    assert!(said(&nameless).contains("says no chat"), "{}", nameless.body);
    assert!(api.get("/api/chats/c1").send().await.body["messages"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn the_chats_other_requests_stay_in_the_channel() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let reply = api
        .post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "request", "arguments": {"action": "move_issues", "fields": {"ids": ["ALPHA-1"], "status": "done"}}}}))
        .header("orrery-actor-kind", "chat")
        .header("orrery-launch", "c1")
        .send()
        .await;
    assert_eq!(said(&reply), "request isn't served at /mcp yet: orrery's channel still has it");
}

/// The chat's `request` for `action` with `fields`, from the chat `c1`.
async fn request(api: &TestApi, action: &str, fields: Value) -> Reply {
    api.post("/mcp", ask("request", json!({"action": action, "fields": fields, "why": "You asked"})))
        .header("orrery-actor-kind", "chat")
        .header("orrery-launch", "c1")
        .send()
        .await
}

#[tokio::test]
async fn the_chats_schedule_asks_are_kept_in_its_chat() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.put("/api/chats/c1", json!({"id": "c1", "project": project, "started_at": "2026-11-01T10:00:00.000Z"})).send().await;
    let made = request(&api, "create_schedule", json!({"title": "Nudge", "kind": "message", "notes": "Hi", "cron": "0 9 * * 1"})).await;
    assert_eq!(
        said(&made),
        "Asked: the owner sees the schedule with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it."
    );
    let id = schedule_id(&api, &project).await;
    let changed = request(&api, "update_schedule", json!({"id": id, "enabled": false})).await;
    assert_eq!(
        said(&changed),
        "Asked: the owner sees the change with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it."
    );
    let messages = api.get("/api/chats/c1").send().await.body["messages"].clone();
    assert_eq!(messages[0]["text"], "You asked");
    assert_eq!(messages[0]["schedule"]["body"], json!({"title": "Nudge", "kind": "message", "notes": "Hi", "cron": "0 9 * * 1"}));
    assert_eq!(messages[1]["schedule"]["id"], id);
    assert_eq!(messages[1]["schedule"]["body"], json!({"enabled": false}));
    assert_eq!(api.get(&format!("/api/projects/{project}/schedules")).send().await.body.as_array().unwrap().len(), 1, "only the one put there");
}

#[tokio::test]
async fn the_chats_schedule_asks_say_no_to_what_schedules_refuse_and_to_a_project_out_of_reach() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.put("/api/chats/c1", json!({"id": "c1", "project": project, "started_at": "2026-11-01T10:00:00.000Z"})).send().await;
    let refused = request(&api, "create_schedule", json!({"title": "X", "untrusted": true})).await;
    assert!(said(&refused).starts_with("orrery said no: "), "{}", refused.body);
    let elsewhere = request(&api, "create_schedule", json!({"title": "X", "cron": "0 9 * * 1", "project": "beta"})).await;
    assert_eq!(said(&elsewhere), "orrery said no: This chat reaches alpha, not beta");
    assert!(api.get("/api/chats/c1").send().await.body["messages"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn the_chats_release_asks_are_kept_in_its_chat() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.patch(&format!("/api/projects/{project}"), json!({"release_mode": "own"})).send().await;
    api.put("/api/chats/c1", json!({"id": "c1", "project": project, "started_at": "2026-11-01T10:00:00.000Z"})).send().await;
    let made = request(&api, "create_release", json!({"version": "1.0.0", "branch": "v1.0.0"})).await;
    assert_eq!(said(&made), "Asked: the owner sees the release with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it.");
    api.post(&format!("/api/projects/{project}/releases"), json!({"version": "0.9.0"})).send().await;
    let changed = request(&api, "update_release", json!({"version": "0.9.0", "notes": "Soon"})).await;
    assert_eq!(
        said(&changed),
        "Asked: the owner sees the change with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it."
    );
    let messages = api.get("/api/chats/c1").send().await.body["messages"].clone();
    assert_eq!(messages[0]["text"], "You asked");
    assert_eq!(messages[0]["release"]["body"], json!({"version": "1.0.0", "branch": "v1.0.0"}));
    assert_eq!(messages[1]["release"]["version"], "0.9.0");
    assert_eq!(messages[1]["release"]["body"], json!({"notes": "Soon"}));
    let releases = api.get(&format!("/api/projects/{project}/releases")).send().await.body;
    assert_eq!(releases.as_array().map(Vec::len), Some(1), "only the one put there: {releases}");
}

#[tokio::test]
async fn the_chats_doc_asks_are_kept_in_its_chat() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.put("/api/chats/c1", json!({"id": "c1", "project": project, "started_at": "2026-11-01T10:00:00.000Z"})).send().await;
    let made = request(&api, "create_doc", json!({"title": "Plan", "body": "Sieve"})).await;
    assert_eq!(said(&made), "Asked: the owner sees the doc with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it.");
    api.post(&format!("/api/projects/{project}/docs"), json!({"title": "Notes", "body": "Hi"})).send().await;
    let changed = request(&api, "update_doc", json!({"id": "notes", "body": "Hello"})).await;
    assert_eq!(
        said(&changed),
        "Asked: the owner sees the change with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it."
    );
    let messages = api.get("/api/chats/c1").send().await.body["messages"].clone();
    assert_eq!(messages[0]["text"], "You asked");
    assert_eq!(messages[0]["doc"]["body"], json!({"title": "Plan", "body": "Sieve"}));
    assert_eq!(messages[1]["doc"]["id"], "notes");
    assert_eq!(messages[1]["doc"]["body"], json!({"body": "Hello"}));
    let refused = request(&api, "create_doc", json!({"title": "X", "kind": "artifact"})).await;
    assert!(said(&refused).starts_with("orrery said no: "), "{}", refused.body);
}

async fn reply(api: &TestApi, launch: Option<&str>, text: &str) -> Reply {
    let request = api
        .post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "reply", "arguments": {"text": text}}}))
        .header("orrery-actor-kind", "chat");
    match launch {
        Some(launch) => request.header("orrery-launch", launch),
        None => request,
    }
    .send()
    .await
}

#[tokio::test]
async fn the_chats_reply_is_said_in_its_chat() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.put("/api/chats/c1", json!({"id": "c1", "project": project, "started_at": "2026-11-01T10:00:00.000Z"})).send().await;
    assert_eq!(said(&reply(&api, Some("c1"), "It's blue now.").await), "Sent.");
    let messages = api.get("/api/chats/c1").send().await.body["messages"].clone();
    assert_eq!((&messages[0]["from"], &messages[0]["text"]), (&json!("claude"), &json!("It's blue now.")));
    let blank = reply(&api, Some("c1"), " ").await;
    assert_eq!(said(&blank), "orrery said no: Send the answer as {\"text\": \"…\"}");
    let nameless = reply(&api, None, "Hi").await;
    assert!(said(&nameless).contains("says no chat"), "{}", nameless.body);
    assert_eq!(api.get("/api/chats/c1").send().await.body["messages"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn the_chats_offer_of_an_issue_is_kept_in_its_chat() {
    let api = TestApi::new().await;
    let project = api.project("alpha").await;
    api.put("/api/chats/c1", json!({"id": "c1", "project": project, "started_at": "2026-11-01T10:00:00.000Z"})).send().await;
    let offered = request(&api, "offer_issue", json!({"title": "Odd sums", "priority": "P2"})).await;
    assert_eq!(
        said(&offered),
        "Offered: the owner sees it as not filed, with File issue and Don't file, and you'll hear which they pressed. Nothing is filed until they press it."
    );
    let message = api.get("/api/chats/c1").send().await.body["messages"][0].clone();
    assert_eq!(message["text"], "You asked");
    assert_eq!(message["issue"], json!({"title": "Odd sums", "state": "asked", "priority": "P2"}));
    let elsewhere = request(&api, "offer_issue", json!({"title": "X", "project": "beta"})).await;
    assert_eq!(said(&elsewhere), "orrery said no: This chat reaches alpha, not beta");
}
