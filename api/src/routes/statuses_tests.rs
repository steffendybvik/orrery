// The tests of routes/statuses.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{Reply, TestApi};
use serde_json::json;
use sqlx::Row;

fn ids(reply: &Reply) -> Vec<String> {
    reply.body.as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect()
}

fn changed(reply: &Reply) -> Vec<String> {
    let mut projects: Vec<String> = reply.header("orrery-changed").unwrap_or_default().split(", ").filter(|p| !p.is_empty()).map(str::to_string).collect();
    projects.sort();
    projects
}

async fn outbox_kinds(api: &TestApi) -> Vec<String> {
    let rows = sqlx::query("SELECT kind FROM changes ORDER BY id").fetch_all(&api.app.pool).await.unwrap();
    rows.iter().map(|r| r.get::<String, _>("kind")).collect()
}

#[tokio::test]
async fn a_new_orrery_has_the_default_statuses_in_board_order() {
    let api = TestApi::new().await;
    let reply = api.get("/api/statuses").send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(ids(&reply), ["backlog", "todo", "in-progress", "in-review", "done", "canceled"]);
    assert_eq!(reply.body[2], json!({"id": "in-progress", "name": "In progress", "kind": "started", "color": "amber", "position": 2.0}));
}

#[tokio::test]
async fn a_new_status_goes_last_and_tells_every_board_and_the_settings() {
    let api = TestApi::new().await;
    let (a, b) = (api.project("Primes").await, api.project("Gears").await);
    let before = outbox_kinds(&api).await.len();
    let reply = api.post("/api/statuses", json!({"name": " QA ", "kind": "started"})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body, json!({"id": "qa", "name": "QA", "kind": "started", "color": "slate", "position": 6.0}));
    let mut both = vec![a, b];
    both.sort();
    assert_eq!(changed(&reply), both);
    assert_eq!(reply.header("orrery-settings"), Some("1"));
    assert_eq!(reply.header("orrery-told"), None);
    let kinds = outbox_kinds(&api).await;
    assert_eq!(kinds[before..].iter().filter(|k| *k == "project.changed").count(), 2);
    assert!(kinds[before..].contains(&"settings".to_string()), "{kinds:?}");
    // Listed with the other started ones, not last, as it's in board order.
    assert_eq!(ids(&api.get("/api/statuses").send().await), ["backlog", "todo", "in-progress", "in-review", "qa", "done", "canceled"]);
}

#[tokio::test]
async fn a_status_takes_its_own_id_colour_and_position() {
    let api = TestApi::new().await;
    let reply = api.post("/api/statuses", json!({"id": "triage", "name": "Needs a look", "kind": "backlog", "color": "#3b82f6", "position": -1})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["id"], "triage");
    assert_eq!(reply.body["color"], "#3b82f6");
    assert_eq!(ids(&api.get("/api/statuses").send().await)[..2], ["triage".to_string(), "backlog".to_string()]);
}

#[tokio::test]
async fn a_bad_status_is_refused_with_its_problems() {
    let api = TestApi::new().await;
    let missing = api.post("/api/statuses", json!({})).send().await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["data"]["problems"], json!(["missing \"name\"", "missing \"kind\""]));
    let wrong = api.post("/api/statuses", json!({"name": "QA", "kind": "doing", "color": "red", "shade": 1})).send().await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.body["data"]["problems"].as_array().unwrap().len(), 3, "{}", wrong.body);
    assert_eq!(api.post("/api/statuses", json!({"name": "Proposed", "kind": "backlog"})).send().await.status, 400, "proposed is taken by proposals");
    assert_eq!(api.post("/api/statuses", json!({"name": "!!!", "kind": "backlog"})).send().await.status, 400, "no id to make");
    assert_eq!(api.post("/api/statuses", json!({"name": "Todo", "kind": "todo"})).send().await.status, 409);
    assert_eq!(ids(&api.get("/api/statuses").send().await).len(), 6, "nothing was made");
}

#[tokio::test]
async fn an_agent_cannot_change_the_statuses() {
    let api = TestApi::new().await;
    for reply in [
        api.post("/api/statuses", json!({"name": "QA", "kind": "started"})).by_agent("claude").send().await,
        api.patch("/api/statuses/todo", json!({"name": "To do"})).by_agent("claude").send().await,
        api.delete("/api/statuses/in-review").by_agent("claude").send().await,
    ] {
        assert_eq!(reply.status, 403, "{}", reply.body);
        assert_eq!(reply.body["data"]["permission"], "settings.write");
    }
    assert_eq!(api.get("/api/statuses").by_agent("claude").send().await.status, 200, "reading them is anyone's");
    assert_eq!(ids(&api.get("/api/statuses").send().await).len(), 6);
}

#[tokio::test]
async fn a_status_is_renamed_recoloured_and_moved() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/statuses/todo", json!({"name": " To do ", "color": "teal", "kind": "todo"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!({"id": "todo", "name": "To do", "kind": "todo", "color": "teal", "position": 1.0}));
    assert_eq!(reply.header("orrery-settings"), Some("1"));
    let moved = api.patch("/api/statuses/in-review", json!({"kind": "done"})).send().await;
    assert_eq!(moved.status, 200);
    assert_eq!(ids(&api.get("/api/statuses").send().await), ["backlog", "todo", "in-progress", "in-review", "done", "canceled"]);
    assert_eq!(api.patch("/api/statuses/in-review", json!({"position": 9})).send().await.body["position"], 9.0);
}

#[tokio::test]
async fn a_status_keeps_its_id_and_its_kind_keeps_one() {
    let api = TestApi::new().await;
    let id = api.patch("/api/statuses/todo", json!({"id": "later"})).send().await;
    assert_eq!(id.status, 400, "{}", id.body);
    let last = api.patch("/api/statuses/backlog", json!({"kind": "todo"})).send().await;
    assert_eq!(last.status, 409, "the only backlog status stays one: {}", last.body);
    assert_eq!(api.patch("/api/statuses/nope", json!({"name": "x"})).send().await.status, 404);
    assert_eq!(api.patch("/api/statuses/todo", json!({"name": ""})).send().await.status, 400);
}

#[tokio::test]
async fn a_status_with_nothing_in_it_is_deleted() {
    let api = TestApi::new().await;
    let reply = api.delete("/api/statuses/in-review").send().await;
    assert_eq!(reply.status, 204, "{}", reply.body);
    assert_eq!(reply.header("orrery-settings"), Some("1"));
    assert!(!ids(&api.get("/api/statuses").send().await).contains(&"in-review".to_string()));
    assert_eq!(api.delete("/api/statuses/in-review").send().await.status, 404);
}

#[tokio::test]
async fn the_last_status_of_a_kind_cannot_be_deleted() {
    let api = TestApi::new().await;
    let reply = api.delete("/api/statuses/backlog").send().await;
    assert_eq!(reply.status, 409, "{}", reply.body);
    api.delete("/api/statuses/in-review").send().await;
    assert_eq!(api.delete("/api/statuses/in-progress").send().await.status, 409);
}

#[tokio::test]
async fn a_status_in_use_moves_its_issues_where_into_says() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let issue = api.issue(&project, json!({"title": "Sieve", "status": "in-review"})).await;
    let refused = api.delete("/api/statuses/in-review").send().await;
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert_eq!(api.delete("/api/statuses/in-review?into=in-review").send().await.status, 400);
    assert_eq!(api.delete("/api/statuses/in-review?into=nope").send().await.status, 404);
    let moved = api.delete("/api/statuses/in-review?into=in-progress").send().await;
    assert_eq!(moved.status, 204, "{}", moved.body);
    assert_eq!(moved.header("orrery-changed"), Some(project.as_str()));
    let read = api.get(&format!("/api/projects/{project}/issues/{issue}")).send().await;
    assert_eq!(read.body["status"], "in-progress", "{}", read.body);
}
