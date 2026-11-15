// A session's record (ORR-1171): kept once by the local app, only ever tightened, and carried to a session's new id.
use crate::testing::{from_outside, TestApi};
use serde_json::{json, Value};

async fn keep(api: &TestApi, session: &str, body: Value) -> (u16, Value) {
    let reply = api.put(&format!("/api/session-records/{session}"), body).send().await;
    (reply.status.as_u16(), reply.body)
}

#[tokio::test]
async fn keeps_an_untrusted_session_with_its_project_and_its_workspace() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let (status, record) = keep(&api, "run-1", json!({"kind": "untrusted", "project": primes})).await;
    assert_eq!(status, 200, "{record}");
    assert_eq!(
        (record["session"].as_str(), record["kind"].as_str(), record["project"].as_str(), record["workspace"].as_str()),
        (Some("run-1"), Some("untrusted"), Some(primes.as_str()), Some("default"))
    );
    // Said again, it's as it was.
    let (status, again) = keep(&api, "run-1", json!({"kind": "untrusted", "project": primes})).await;
    assert_eq!((status, &again), (200, &record));
}

#[tokio::test]
async fn a_record_is_only_ever_tightened() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let sieves = api.project("Sieves").await;
    // The chat can be found to be an untrusted run's, never the other way.
    assert_eq!(keep(&api, "s", json!({"kind": "chat"})).await.0, 200);
    let (status, record) = keep(&api, "s", json!({"kind": "untrusted"})).await;
    assert_eq!((status, record["kind"].as_str(), &record["project"]), (200, Some("untrusted"), &Value::Null));
    let (status, refused) = keep(&api, "s", json!({"kind": "chat"})).await;
    assert_eq!(status, 409, "{refused}");
    assert!(refused["message"].as_str().unwrap().contains("kept as untrusted"), "{refused}");
    // Held to a project once one is said, and never moved to another.
    let (status, record) = keep(&api, "s", json!({"kind": "untrusted", "project": primes})).await;
    assert_eq!((status, record["project"].as_str()), (200, Some(primes.as_str())));
    let (status, refused) = keep(&api, "s", json!({"kind": "untrusted", "project": sieves})).await;
    assert_eq!(status, 409, "{refused}");
    assert!(refused["message"].as_str().unwrap().contains(&format!("held to {primes}")), "{refused}");
    // Saying less leaves it be.
    let (status, record) = keep(&api, "s", json!({"kind": "untrusted"})).await;
    assert_eq!((status, record["project"].as_str()), (200, Some(primes.as_str())));
    // The chat holds no project.
    let (_, chat) = keep(&api, "c", json!({"kind": "chat", "project": primes})).await;
    assert_eq!(chat["project"], Value::Null);
}

#[tokio::test]
async fn only_the_local_app_records_a_session_and_only_as_untrusted_or_the_chat() {
    let api = TestApi::new().await;
    let outside = from_outside(api.put("/api/session-records/s", json!({"kind": "untrusted"}))).send().await;
    assert_eq!(outside.status, 403, "{}", outside.body);
    assert_eq!(keep(&api, "s", json!({"kind": "owner"})).await.0, 400);
    assert_eq!(keep(&api, "s", json!({})).await.0, 400);
    assert_eq!(keep(&api, "s", json!({"kind": "untrusted", "project": 7})).await.0, 400);
}

#[tokio::test]
async fn a_cleared_session_keeps_its_record_under_its_new_id() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let sieves = api.project("Sieves").await;
    api.record_session("old", "untrusted", Some(&primes)).await;
    let renamed = api.post(&format!("/api/projects/{primes}/issue-sessions/rename"), json!({"from": "old", "to": "new"})).send().await;
    assert_eq!(renamed.status, 200, "{}", renamed.body);
    // The new id is held as the old one was, and the old one still is.
    let (status, refused) = keep(&api, "new", json!({"kind": "untrusted", "project": sieves})).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(keep(&api, "old", json!({"kind": "chat"})).await.0, 409);
}
