// The tests of routes/database.rs (ORR-1097), through `router()` on a database of their own (`crate::testing`).
use crate::db::on_postgres;
use crate::testing::TestApi;
use serde_json::json;

#[tokio::test]
async fn a_new_orrerys_database_is_fresh_until_it_has_a_project_or_an_owner() {
    let api = TestApi::new().await;
    let reply = api.get("/api/database").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["fresh"], true);
    assert_eq!(reply.body.get("size").is_some(), on_postgres(), "only a Postgres database's size is the API's");
    api.owner().await;
    assert_eq!(api.get("/api/database").send().await.body["fresh"], false);

    let api = TestApi::new().await;
    api.board().await;
    assert_eq!(api.get("/api/database").send().await.body["fresh"], false);
}

#[tokio::test]
async fn compacting_waits_for_enough_free_unless_asked_always() {
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    let first = api.post("/api/database/compact", json!({})).send().await;
    assert_eq!(first.status, 200, "{}", first.body);
    // A new board has next to nothing free, so it's let be; and a Postgres database keeps its own space.
    assert_eq!(first.body, json!({"compacted": false}));
    let always = api.post("/api/database/compact", json!({"always": true})).send().await;
    assert_eq!(always.status, 200, "{}", always.body);
    assert_eq!(always.body, json!({"compacted": !on_postgres()}));
    // The board is still there after.
    assert_eq!(api.get(&format!("/api/projects/{project}")).send().await.status, 200);
}
