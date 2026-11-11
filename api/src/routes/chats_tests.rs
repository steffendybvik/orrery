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
