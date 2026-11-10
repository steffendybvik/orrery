// The tests of routes/usage.rs (ORR-1089), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use chrono::{Duration, Utc};
use serde_json::{json, Value};

fn day(ago: i64) -> String {
    (Utc::now() - Duration::days(ago)).format("%Y-%m-%d").to_string()
}

fn feature<'v>(reply: &'v Value, name: &str) -> &'v Value {
    reply["features"].as_array().unwrap().iter().find(|f| f["feature"] == name).unwrap_or_else(|| panic!("no {name} in {reply}"))
}

#[tokio::test]
async fn a_new_orrery_lists_every_feature_unused_and_counting_off() {
    let api = TestApi::new().await;
    let reply = api.get("/api/usage").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["on"], false);
    assert_eq!(reply.body.get("allowed"), None, "the router adds it");
    let features = reply.body["features"].as_array().unwrap();
    assert_eq!(features.len(), 13);
    assert_eq!(feature(&reply.body, "chat"), &json!({"feature": "chat", "label": "Starting a chat", "last": null, "days30": 0, "days90": 0}));
    // Never used, so A–Z by label.
    assert_eq!(features[0]["label"], "Back up now");
}

#[tokio::test]
async fn counts_add_up_by_day_coldest_first_and_a_year_on_theyre_gone() {
    let api = TestApi::new().await;
    let sent = json!({"counts": [
        {"feature": "chat", "day": day(1), "count": 2},
        {"feature": "chat", "day": day(60), "count": 3},
        {"feature": "page:board", "day": day(0), "count": 5},
        {"feature": "backup-now", "day": day(400), "count": 9},
    ]});
    assert_eq!(api.put("/api/usage", sent).send().await.status, 204);
    assert_eq!(api.put("/api/usage", json!({"counts": [{"feature": "chat", "day": day(1), "count": 1}]})).send().await.status, 204);
    let reply = api.get("/api/usage").send().await.body;
    assert_eq!(feature(&reply, "chat"), &json!({"feature": "chat", "label": "Starting a chat", "last": day(1), "days30": 3, "days90": 6}));
    assert_eq!(feature(&reply, "page:board"), &json!({"feature": "page:board", "label": "board", "last": day(0), "days30": 5, "days90": 5}));
    assert_eq!(feature(&reply, "backup-now")["last"], Value::Null);
    let names: Vec<&str> = reply["features"].as_array().unwrap().iter().map(|f| f["feature"].as_str().unwrap()).collect();
    assert_eq!(names[names.len() - 2..], ["page:board", "chat"]);
}

#[tokio::test]
async fn a_count_that_isnt_one_is_refused_whole() {
    let api = TestApi::new().await;
    for counts in [
        json!("chat"),
        json!([{"feature": "Not One", "day": day(0), "count": 1}]),
        json!([{"feature": "chat", "day": "today", "count": 1}]),
        json!([{"feature": "chat", "day": day(0), "count": 0}]),
    ] {
        let reply = api.put("/api/usage", json!({"counts": counts})).send().await;
        assert_eq!(reply.status, 400, "{counts}: {}", reply.body);
    }
    assert_eq!(api.count("SELECT COUNT(*) FROM feature_use").await, 0);
}

#[tokio::test]
async fn only_the_local_app_sends_counts() {
    let api = TestApi::new().await;
    // A request the router passed on, from a page on this machine, not the Nuxt server's own.
    let reply = api.put("/api/usage", json!({"counts": []})).header("orrery-came", "loopback").send().await;
    assert_eq!(reply.status, 403, "{}", reply.body);
    assert_eq!(reply.body["message"], "Only the local app sends the feature counts it gathered");
}

#[tokio::test]
async fn reading_them_is_the_owners_and_forgetting_them_too() {
    let api = TestApi::new().await;
    api.put("/api/usage", json!({"counts": [{"feature": "chat", "day": day(0), "count": 1}]})).send().await;
    let read = api.get("/api/usage").by_agent("claude").send().await;
    assert_eq!(read.status, 403);
    assert_eq!(read.body["message"], "How the features are used is the owner's to read");
    assert_eq!(api.delete("/api/usage").by_agent("claude").send().await.status, 403);
    assert_eq!(api.count("SELECT COUNT(*) FROM feature_use").await, 1);
    assert_eq!(api.delete("/api/usage").send().await.status, 204);
    assert_eq!(api.count("SELECT COUNT(*) FROM feature_use").await, 0);
}

#[tokio::test]
async fn the_switch_is_the_owners_setting() {
    let api = TestApi::new().await;
    assert_eq!(api.patch("/api/settings", json!({"count_use": true})).send().await.status, 200);
    assert_eq!(api.get("/api/usage").send().await.body["on"], true);
}
