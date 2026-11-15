// The tests of routes/permissions.rs (ORR-1086), through `router()` on a database of their own (`crate::testing`).
use crate::access::rails::PERMISSIONS;
use crate::testing::TestApi;
use serde_json::{json, Value};

#[tokio::test]
async fn the_table_is_the_file_as_written() {
    let api = TestApi::new().await;
    let reply = api.get("/api/permissions").send().await;
    assert_eq!(reply.status, 200);
    let file: Value = serde_json::from_str(include_str!("../../permissions.json")).unwrap();
    assert_eq!(reply.body, file);
    assert_eq!(reply.body["levels"]["asks"], "Asks you");
    assert_eq!(reply.body["kinds"], json!({"session": "A working session", "chat": "The owner's chat", "untrusted": "An untrusted session"}));
    // Each row whole, the page's notes and the session's column too, and the same rows the rails hold writes to.
    let rows = reply.body["permissions"].as_array().unwrap();
    assert_eq!(rows.len(), PERMISSIONS.len());
    assert!(rows.iter().all(|row| row["area"].is_string() && row["session"]["level"].is_string()), "{rows:?}");
}

#[tokio::test]
async fn any_kind_of_session_can_read_it() {
    let api = TestApi::new().await;
    for reply in [api.get("/api/permissions").by_agent("claude").send().await, api.get("/api/permissions").untrusted().send().await] {
        assert_eq!(reply.status, 200, "{}", reply.body);
        assert!(reply.body["permissions"].is_array());
    }
}
