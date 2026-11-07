// The tests of routes/chats.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};

fn chat(id: &str, project: &str, started_at: &str) -> Value {
    json!({"id": id, "project": project, "started_at": started_at, "messages": [{"role": "owner", "text": "Hi"}], "model": "sonnet"})
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
    later["messages"] = json!([{"role": "owner", "text": "Hi"}, {"role": "agent", "text": "Hello"}]);
    later["ended_at"] = json!("2026-11-01T11:00:00.000Z");
    assert_eq!(api.put("/api/chats/c1", later).send().await.status, 204);
    let read = api.get("/api/chats/c1").send().await.body;
    assert_eq!(read["messages"].as_array().unwrap().len(), 2, "the chat as it is now");
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
    let reply = api.put("/api/chats/c1", json!({"id": "c2", "project": 3, "messages": {}, "ended_at": 5})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "5 problems in the body");
    assert_eq!(
        reply.body["data"]["problems"],
        json!([
            "\"id\" should be the chat's, \"c1\"",
            "\"project\" should be a string",
            "\"started_at\" should be a string",
            "\"messages\" should be a list",
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
