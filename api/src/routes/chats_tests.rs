// The tests of routes/chats.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};

fn chat(id: &str, project: &str, started_at: &str) -> Value {
    json!({"id": id, "project": project, "started_at": started_at, "messages": [], "model": "sonnet"})
}

fn said(from: &str, text: &str) -> Value {
    json!({"from": from, "text": text, "images": []})
}

#[tokio::test]
async fn no_chats_are_kept_at_first() {
    let api = TestApi::new().await;
    let reply = api.get("/api/chats").send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, json!([]));
}

#[tokio::test]
async fn a_kept_chat_reads_back_whole() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let sent = chat("c1", &project, "2026-11-01T10:00:00.000Z");
    let reply = api.put("/api/chats/c1", sent.clone()).send().await;
    assert_eq!(reply.status, 204, "{}", reply.body);
    assert_eq!(reply.body, Value::Null);
    let read = api.get("/api/chats/c1").send().await;
    assert_eq!(read.status, 200);
    assert_eq!(read.body, sent);
}

#[tokio::test]
async fn why_a_launcher_couldnt_start_a_chat_isnt_kept() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let mut sent = chat("c1", &project, "2026-11-01T10:00:00.000Z");
    sent["problem"] = json!("No terminal");
    api.put("/api/chats/c1", sent).send().await;
    let read = api.get("/api/chats/c1").send().await.body;
    assert!(read.get("problem").is_none(), "{read}");
}

#[tokio::test]
async fn keeping_a_chat_again_changes_it_but_not_its_project_or_start() {
    let api = TestApi::new().await;
    let first = api.project("Primes").await;
    let second = api.project("Squares").await;
    api.put("/api/chats/c1", chat("c1", &first, "2026-11-01T10:00:00.000Z")).send().await;
    let mut later = chat("c1", &second, "2026-11-05T10:00:00.000Z");
    later["model"] = json!("opus");
    later["ended_at"] = json!("2026-11-01T11:00:00.000Z");
    assert_eq!(api.put("/api/chats/c1", later).send().await.status, 204);
    let read = api.get("/api/chats/c1").send().await.body;
    assert_eq!(read["model"], "opus", "the chat as it is now");
    assert_eq!(read["ended_at"], "2026-11-01T11:00:00.000Z");
    assert_eq!(read["project"], json!(first), "its project stays as first kept");
    let rows: (String, String, Option<String>) =
        sqlx::query_as("SELECT project, started_at, ended_at FROM chats WHERE id = 'c1'").fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(rows, (first, "2026-11-01T10:00:00.000Z".into(), Some("2026-11-01T11:00:00.000Z".into())));
}

#[tokio::test]
async fn the_chats_are_listed_newest_first() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/old", chat("old", &project, "2026-10-01T10:00:00.000Z")).send().await;
    api.put("/api/chats/new", chat("new", &project, "2026-11-03T10:00:00.000Z")).send().await;
    api.put("/api/chats/mid", chat("mid", &project, "2026-10-15T10:00:00.000Z")).send().await;
    let reply = api.get("/api/chats").send().await;
    let ids: Vec<&str> = reply.body.as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["new", "mid", "old"]);
    assert!(reply.body.as_array().unwrap().iter().all(|c| c["project"] == json!(project) && c["messages"].is_array()));
}

#[tokio::test]
async fn a_chat_it_doesnt_keep_is_a_404() {
    let api = TestApi::new().await;
    let reply = api.get("/api/chats/nope").send().await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.body["message"], "No chat nope");
}

#[tokio::test]
async fn a_forgotten_chat_is_gone() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    api.put("/api/chats/c2", chat("c2", &project, "2026-11-02T10:00:00.000Z")).send().await;
    let reply = api.delete("/api/chats/c1").send().await;
    assert_eq!(reply.status, 204);
    assert_eq!(api.get("/api/chats/c1").send().await.status, 404);
    assert_eq!(api.get("/api/chats").send().await.body.as_array().unwrap().len(), 1, "the other stays");
}

#[tokio::test]
async fn forgetting_a_chat_it_doesnt_keep_is_fine() {
    let api = TestApi::new().await;
    assert_eq!(api.delete("/api/chats/never").send().await.status, 204);
}

#[tokio::test]
async fn a_chat_thats_not_an_object_is_refused() {
    let api = TestApi::new().await;
    let reply = api.put("/api/chats/c1", json!("hello")).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "The body should be the chat, a JSON object");
}

#[tokio::test]
async fn a_chat_missing_its_parts_is_refused_with_each_problem() {
    let api = TestApi::new().await;
    let reply = api.put("/api/chats/c1", json!({"id": "c2", "project": 3, "ended_at": 5})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "4 problems in the body");
    assert_eq!(
        reply.body["data"]["problems"],
        json!([
            "\"id\" should be the chat's, \"c1\"",
            "\"project\" should be a string",
            "\"started_at\" should be a string",
            "\"ended_at\" should be a string",
        ])
    );
    assert_eq!(api.get("/api/chats").send().await.body, json!([]), "nothing is kept");
}

#[tokio::test]
async fn a_running_chat_has_no_end_kept() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let mut sent = chat("c1", &project, "2026-11-01T10:00:00.000Z");
    sent["ended_at"] = Value::Null;
    assert_eq!(api.put("/api/chats/c1", sent).send().await.status, 204);
    let ended: Option<String> = sqlx::query_scalar("SELECT ended_at FROM chats WHERE id = 'c1'").fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(ended, None);
}

#[tokio::test]
async fn a_message_added_is_given_its_id_and_time_and_reads_back_with_the_chat() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let mut sent = said("owner", "Hi");
    sent["id"] = json!(99);
    sent["at"] = json!("1999-01-01T00:00:00.000Z");
    let first = api.post("/api/chats/c1/lines", sent).send().await;
    assert_eq!(first.status, 201, "{}", first.body);
    assert_eq!(first.body["id"], 1, "its id is the API's, not the one sent");
    assert_ne!(first.body["at"], "1999-01-01T00:00:00.000Z");
    assert_eq!(first.body["text"], "Hi");
    let asked = json!({"from": "claude", "text": "", "images": [], "request": {"setting": "tint", "from": null, "to": "blue", "state": "asked"}});
    let second = api.post("/api/chats/c1/lines", asked).send().await.body;
    assert_eq!(second["id"], 2);
    let read = api.get("/api/chats/c1").send().await.body;
    let messages = read["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0], first.body);
    assert_eq!(messages[1]["request"]["to"], "blue");
    let listed = api.get("/api/chats").send().await.body;
    assert_eq!(listed[0]["messages"], read["messages"]);
}

#[tokio::test]
async fn message_ids_run_on_across_chats() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    api.put("/api/chats/c2", chat("c2", &project, "2026-11-02T10:00:00.000Z")).send().await;
    api.post("/api/chats/c1/lines", said("owner", "One")).send().await;
    let other = api.post("/api/chats/c2/lines", said("owner", "Two")).send().await.body;
    assert_eq!(other["id"], 2);
    let listed = api.get("/api/chats").send().await.body;
    assert_eq!(listed[0]["messages"].as_array().unwrap().len(), 1, "each chat has its own");
    assert_eq!(listed[1]["messages"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn keeping_a_chat_again_leaves_its_messages_as_they_are() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    api.post("/api/chats/c1/lines", said("owner", "Hi")).send().await;
    let mut again = chat("c1", &project, "2026-11-01T10:00:00.000Z");
    again["messages"] = json!([said("owner", "Something else")]);
    assert_eq!(api.put("/api/chats/c1", again).send().await.status, 204);
    let read = api.get("/api/chats/c1").send().await.body;
    assert_eq!(read["messages"].as_array().unwrap().len(), 1);
    assert_eq!(read["messages"][0]["text"], "Hi");
    let kept: String = sqlx::query_scalar("SELECT chat FROM chats WHERE id = 'c1'").fetch_one(&api.app.pool).await.unwrap();
    assert!(!kept.contains("messages"), "the chat's own row holds none: {kept}");
}

#[tokio::test]
async fn a_message_changed_keeps_its_id_and_time() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let asked = json!({"from": "claude", "text": "", "images": [], "request": {"setting": "tint", "from": null, "to": "blue", "state": "asked"}});
    let first = api.post("/api/chats/c1/lines", asked.clone()).send().await.body;
    let mut answered = asked;
    answered["request"]["state"] = json!("allowed");
    answered["id"] = json!(7);
    let reply = api.put("/api/chats/c1/lines/1", answered).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["id"], 1);
    assert_eq!(reply.body["at"], first["at"]);
    assert_eq!(reply.body["request"]["state"], "allowed");
    assert_eq!(api.get("/api/chats/c1").send().await.body["messages"][0], reply.body);
}

#[tokio::test]
async fn a_message_to_a_chat_or_message_it_doesnt_keep_is_a_404() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let reply = api.post("/api/chats/nope/lines", said("owner", "Hi")).send().await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.body["message"], "No chat nope");
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    for path in ["/api/chats/c1/lines/4", "/api/chats/c1/lines/four"] {
        let reply = api.put(path, said("owner", "Hi")).send().await;
        assert_eq!(reply.status, 404, "{path}");
    }
}

#[tokio::test]
async fn a_message_missing_its_parts_is_refused_with_each_problem() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let reply = api.post("/api/chats/c1/lines", json!({"from": "agent", "images": [3]})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(
        reply.body["data"]["problems"],
        json!(["\"from\" should be \"owner\" or \"claude\"", "\"text\" should be a string", "\"images\" should be a list of upload ids"])
    );
    assert_eq!(api.post("/api/chats/c1/lines", json!([])).send().await.status, 400);
}

#[tokio::test]
async fn a_forgotten_chats_messages_go_with_it() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    api.post("/api/chats/c1/lines", said("owner", "Hi")).send().await;
    api.delete("/api/chats/c1").send().await;
    assert_eq!(api.count("SELECT COUNT(*) FROM chat_messages").await, 0);
}

#[tokio::test]
async fn adding_or_changing_a_message_says_so_in_the_outbox_but_keeping_the_chat_doesnt() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let chat_rows = || async {
        let read = api.get("/api/changes").send().await.body;
        read["changes"].as_array().unwrap().iter().filter(|c| c["kind"] == "chat").map(|c| c["subject"].as_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    assert!(chat_rows().await.is_empty(), "keeping the chat's row is the local app's own, so it says nothing");
    api.post("/api/chats/c1/lines", said("claude", "Hi")).send().await;
    assert_eq!(chat_rows().await, ["c1"]);
    api.put("/api/chats/c1/lines/1", said("claude", "Hello")).send().await;
    assert_eq!(chat_rows().await, ["c1", "c1"]);
    // A refused write says nothing.
    api.post("/api/chats/nope/lines", said("claude", "Hi")).send().await;
    assert_eq!(chat_rows().await.len(), 2);
}

#[tokio::test]
async fn the_chat_asks_to_change_a_setting_and_nothing_is_saved_until_allowed() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let asked = api.post("/api/chats/c1/setting-requests", json!({"setting": "handle", "value": "Ada", "why": " Shorter "})).send().await;
    assert_eq!(asked.status, 201, "{}", asked.body);
    assert_eq!(asked.body["from"], "claude");
    assert_eq!(asked.body["text"], "Shorter");
    assert_eq!(asked.body["request"], json!({"setting": "handle", "from": null, "to": "ada", "state": "asked"}));
    assert_eq!(api.get("/api/chats/c1").send().await.body["messages"][0], asked.body);
    assert!(api.get("/api/settings").send().await.body["handle"].is_null(), "nothing is saved until the owner allows it");
    let read = api.get("/api/changes").send().await.body;
    assert!(read["changes"].as_array().unwrap().iter().any(|c| c["kind"] == "chat" && c["subject"] == "c1"), "{read}");
}

#[tokio::test]
async fn asking_for_the_same_setting_again_expires_the_unanswered_ask() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    api.post("/api/chats/c1/setting-requests", json!({"setting": "tint", "value": "blue"})).send().await;
    api.post("/api/chats/c1/setting-requests", json!({"setting": "advanced", "value": true})).send().await;
    api.post("/api/chats/c1/setting-requests", json!({"setting": "tint", "value": "green"})).send().await;
    let messages = api.get("/api/chats/c1").send().await.body["messages"].clone();
    let states: Vec<(&str, &str)> =
        messages.as_array().unwrap().iter().map(|m| (m["request"]["setting"].as_str().unwrap(), m["request"]["state"].as_str().unwrap())).collect();
    assert_eq!(states, [("tint", "expired"), ("advanced", "asked"), ("tint", "asked")]);
}

#[tokio::test]
async fn the_chat_asks_only_for_its_settings_as_the_settings_take_them_and_only_while_it_runs() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let owners = api.post("/api/chats/c1/setting-requests", json!({"setting": "instructions", "value": []})).send().await;
    assert_eq!(owners.status, 400);
    assert!(owners.body["message"].as_str().unwrap().contains("the rest are the owner's"), "{}", owners.body);
    assert_eq!(api.post("/api/chats/c1/setting-requests", json!({"setting": "tint"})).send().await.status, 400);
    assert_eq!(api.post("/api/chats/c1/setting-requests", json!({"setting": "advanced", "value": null})).send().await.status, 400);
    assert_eq!(api.post("/api/chats/nope/setting-requests", json!({"setting": "tint", "value": "blue"})).send().await.status, 404);
    let mut over = chat("c1", &project, "2026-11-01T10:00:00.000Z");
    over["ended_at"] = json!("2026-11-01T11:00:00.000Z");
    api.put("/api/chats/c1", over).send().await;
    assert_eq!(api.post("/api/chats/c1/setting-requests", json!({"setting": "tint", "value": "blue"})).send().await.status, 404);
    assert!(api.get("/api/chats/c1").send().await.body["messages"].as_array().unwrap().is_empty());
}

/// Schedule `title` on `project`, put there with SQL.
async fn nightly(api: &TestApi, project: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(&crate::db::sql(
        "INSERT INTO schedules (project, title, kind, notes, cron, timezone, created_by, created_at, updated_at) \
         VALUES (?, 'Nightly', 'message', 'Hi', '0 2 * * *', 'UTC', 'owner', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z') RETURNING id",
    ))
    .bind(project)
    .fetch_one(&api.app.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn the_chat_asks_for_a_schedule_and_nothing_is_saved_until_allowed() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let fields = json!({"title": "Nudge", "kind": "message", "notes": "Hi", "cron": "0 9 * * 1"});
    let asked = api.post("/api/chats/c1/schedule-requests", json!({"schedule": fields, "why": " You asked "})).send().await;
    assert_eq!(asked.status, 201, "{}", asked.body);
    assert_eq!(asked.body["from"], "claude");
    assert_eq!(asked.body["text"], "You asked");
    let request = &asked.body["schedule"];
    assert_eq!(request["title"], "Nudge");
    assert_eq!(request["state"], "asked");
    assert_eq!(request["body"], fields);
    assert!(request.get("id").is_none() && request.get("project").is_none(), "{request}");
    assert_eq!(request["changes"][0], json!({"field": "title", "to": "Nudge"}));
    assert_eq!(api.get("/api/chats/c1").send().await.body["messages"][0], asked.body);
    assert_eq!(api.get(&format!("/api/projects/{project}/schedules")).send().await.body, json!([]), "nothing is saved until the owner allows it");
    let read = api.get("/api/changes").send().await.body;
    assert!(read["changes"].as_array().unwrap().iter().any(|c| c["kind"] == "chat" && c["subject"] == "c1"), "{read}");
}

#[tokio::test]
async fn asking_to_change_the_same_schedule_again_expires_the_unanswered_ask() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let id = nightly(&api, &project).await;
    let first = api.post("/api/chats/c1/schedule-requests", json!({"id": id, "schedule": {"enabled": false}})).send().await;
    assert_eq!(first.status, 201, "{}", first.body);
    assert_eq!(first.body["schedule"]["changes"][0], json!({"field": "enabled", "from": true, "to": false}));
    api.post("/api/chats/c1/schedule-requests", json!({"schedule": {"title": "New", "kind": "message", "notes": "Hi", "cron": "0 9 * * 1"}})).send().await;
    api.post("/api/chats/c1/schedule-requests", json!({"id": id, "schedule": {"title": "Nightly too"}})).send().await;
    let messages = api.get("/api/chats/c1").send().await.body["messages"].clone();
    let states: Vec<&str> = messages.as_array().unwrap().iter().map(|m| m["schedule"]["state"].as_str().unwrap()).collect();
    assert_eq!(states, ["expired", "asked", "asked"]);
}

#[tokio::test]
async fn the_chat_asks_for_a_schedule_on_another_project_it_names() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let other = api.project("Evens").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let fields = json!({"title": "Nudge", "kind": "message", "notes": "Hi", "cron": "0 9 * * 1"});
    let there = api.post("/api/chats/c1/schedule-requests", json!({"schedule": fields, "project": other})).send().await;
    assert_eq!(there.status, 201, "{}", there.body);
    assert_eq!(there.body["schedule"]["project"], json!(other));
    let own = api.post("/api/chats/c1/schedule-requests", json!({"schedule": fields, "project": project})).send().await;
    assert!(own.body["schedule"].get("project").is_none(), "the chat's own project goes unsaid");
    assert_eq!(api.post("/api/chats/c1/schedule-requests", json!({"schedule": fields, "project": "nope"})).send().await.status, 404);
    assert_eq!(api.post("/api/chats/c1/schedule-requests", json!({"schedule": fields, "project": 3})).send().await.status, 400);
}

#[tokio::test]
async fn the_chat_asks_only_for_what_schedules_take_and_only_while_it_runs() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let untrusted = api.post("/api/chats/c1/schedule-requests", json!({"schedule": {"title": "X", "untrusted": true}})).send().await;
    assert_eq!(untrusted.status, 403);
    assert!(untrusted.body["message"].as_str().unwrap().starts_with("The owner's chat sets a schedule's"), "{}", untrusted.body);
    assert_eq!(api.post("/api/chats/c1/schedule-requests", json!({"schedule": {}})).send().await.status, 400);
    assert_eq!(api.post("/api/chats/c1/schedule-requests", json!({"id": "one", "schedule": {"enabled": false}})).send().await.status, 400);
    assert_eq!(api.post("/api/chats/c1/schedule-requests", json!({"id": 999, "schedule": {"enabled": false}})).send().await.status, 404);
    let fields = json!({"title": "Nudge", "kind": "message", "notes": "Hi", "cron": "0 9 * * 1"});
    assert_eq!(api.post("/api/chats/nope/schedule-requests", json!({"schedule": fields})).send().await.status, 404);
    let mut over = chat("c1", &project, "2026-11-01T10:00:00.000Z");
    over["ended_at"] = json!("2026-11-01T11:00:00.000Z");
    api.put("/api/chats/c1", over).send().await;
    assert_eq!(api.post("/api/chats/c1/schedule-requests", json!({"schedule": fields})).send().await.status, 404);
    assert!(api.get("/api/chats/c1").send().await.body["messages"].as_array().unwrap().is_empty());
}

/// A chat `c1` on a project with releases of its own, and release 1.0.0 there below 2.0.0: the project.
async fn releasing(api: &TestApi) -> String {
    let project = api.project("Primes").await;
    api.patch(&format!("/api/projects/{project}"), json!({"release_mode": "own"})).send().await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    api.post(&format!("/api/projects/{project}/releases"), json!({"version": "1.0.0", "branch": "v1.0.0"})).send().await;
    api.post(&format!("/api/projects/{project}/releases"), json!({"version": "2.0.0"})).send().await;
    project
}

#[tokio::test]
async fn the_chat_asks_for_a_release_and_nothing_is_saved_until_allowed() {
    let api = TestApi::new().await;
    let project = releasing(&api).await;
    let fields = json!({"version": "3.0.0", "branch": "v3.0.0", "position": 1});
    let asked = api.post("/api/chats/c1/release-requests", json!({"release": fields, "why": " Next "})).send().await;
    assert_eq!(asked.status, 201, "{}", asked.body);
    assert_eq!(asked.body["text"], "Next");
    assert_eq!(
        asked.body["release"],
        json!({"version": "3.0.0", "change": false, "changes": [
            {"field": "version", "to": "3.0.0"}, {"field": "branch", "to": "v3.0.0"}, {"field": "position", "to": "2nd from the top"}
        ], "body": fields, "state": "asked"})
    );
    let releases = api.get(&format!("/api/projects/{project}/releases")).send().await.body;
    assert_eq!(releases.as_array().map(Vec::len), Some(2), "nothing is saved until the owner allows it: {releases}");
    let read = api.get("/api/changes").send().await.body;
    assert!(read["changes"].as_array().unwrap().iter().any(|c| c["kind"] == "chat" && c["subject"] == "c1"), "{read}");
}

/// `POST /api/chats/:chat/replies` as the chat `launch`'s own session sends it.
fn reply_in(api: &TestApi, chat: &str, launch: &str, body: Value) -> crate::testing::Req {
    api.post(&format!("/api/chats/{chat}/replies"), body).header("orrery-actor-kind", "chat").header("orrery-launch", launch)
}

#[tokio::test]
async fn the_chats_session_answers_in_it_and_the_local_app_hears() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let said = reply_in(&api, "c1", "c1", json!({"text": "  Done: it's blue.\n"})).send().await;
    assert_eq!(said.status, 201, "{}", said.body);
    assert_eq!((&said.body["from"], &said.body["text"], &said.body["images"]), (&json!("claude"), &json!("Done: it's blue."), &json!([])));
    assert!(said.body["id"].is_number() && said.body["at"].is_string());
    assert_eq!(api.get("/api/chats/c1").send().await.body["messages"][0], said.body);
    let read = api.get("/api/changes").send().await.body;
    assert!(read["changes"].as_array().unwrap().iter().any(|c| c["kind"] == "chat" && c["subject"] == "c1"), "{read}");
}

#[tokio::test]
async fn the_chat_asks_to_change_a_release_from_what_it_is_and_again_expires_the_ask() {
    let api = TestApi::new().await;
    releasing(&api).await;
    let first =
        api.post("/api/chats/c1/release-requests", json!({"version": "1.0.0", "release": {"branch": "v1", "notes": "Soon", "position": 0}})).send().await;
    assert_eq!(first.status, 201, "{}", first.body);
    assert_eq!(first.body["release"]["change"], true);
    assert_eq!(
        first.body["release"]["changes"],
        json!([
            {"field": "branch", "from": "v1.0.0", "to": "v1"},
            {"field": "notes", "from": null, "to": "Soon"},
            {"field": "position", "from": "2nd from the top", "to": "the top"}
        ])
    );
    api.post("/api/chats/c1/release-requests", json!({"version": "2.0.0", "release": {"notes": "Later"}})).send().await;
    api.post("/api/chats/c1/release-requests", json!({"version": "1.0.0", "release": {"notes": "Sooner"}})).send().await;
    let messages = api.get("/api/chats/c1").send().await.body["messages"].clone();
    let states: Vec<&str> = messages.as_array().unwrap().iter().map(|m| m["release"]["state"].as_str().unwrap()).collect();
    assert_eq!(states, ["expired", "asked", "asked"]);
}

#[tokio::test]
async fn the_chat_asks_only_for_what_releases_take() {
    let api = TestApi::new().await;
    releasing(&api).await;
    let ask = |body: Value| api.post("/api/chats/c1/release-requests", body).send();
    let owned = ask(json!({"release": {"version": "4.0.0", "owned": true}})).await;
    assert_eq!(owned.status, 403);
    assert!(owned.body["message"].as_str().unwrap().starts_with("The owner's chat sets a release's"), "{}", owned.body);
    assert_eq!(ask(json!({"release": {}})).await.status, 400);
    assert_eq!(ask(json!({"release": {"version": "1.0.0"}})).await.status, 409, "one made already");
    assert_eq!(ask(json!({"release": {"version": "bad version"}})).await.status, 400);
    assert_eq!(ask(json!({"version": "9.9.9", "release": {"notes": "x"}})).await.status, 404);
    assert_eq!(ask(json!({"version": "1.0.0", "release": {"version": "1.0.1"}})).await.status, 400, "its version can't change");
    assert_eq!(ask(json!({"version": 1, "release": {"notes": "x"}})).await.status, 400);
    assert!(api.get("/api/chats/c1").send().await.body["messages"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn only_the_chats_own_session_answers_in_it_with_words_while_it_runs() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    api.put("/api/chats/c1", chat("c1", &project, "2026-11-01T10:00:00.000Z")).send().await;
    let other = reply_in(&api, "c1", "c2", json!({"text": "Hi"})).send().await;
    assert_eq!((other.status.as_u16(), &other.body["message"]), (403, &json!("Only the chat's own session answers in it")));
    assert_eq!(api.post("/api/chats/c1/replies", json!({"text": "Hi"})).header("orrery-launch", "c1").send().await.status, 403, "not a chat");
    for blank in [json!({"text": "  "}), json!({}), json!({"text": 3})] {
        let refused = reply_in(&api, "c1", "c1", blank).send().await;
        assert_eq!((refused.status.as_u16(), &refused.body["message"]), (400, &json!("Send the answer as {\"text\": \"…\"}")));
    }
    assert_eq!(reply_in(&api, "nope", "nope", json!({"text": "Hi"})).send().await.status, 404);
    let mut over = chat("c1", &project, "2026-11-01T10:00:00.000Z");
    over["ended_at"] = json!("2026-11-01T11:00:00.000Z");
    api.put("/api/chats/c1", over).send().await;
    assert_eq!(reply_in(&api, "c1", "c1", json!({"text": "Hi"})).send().await.status, 404);
    assert!(api.get("/api/chats/c1").send().await.body["messages"].as_array().unwrap().is_empty());
}
