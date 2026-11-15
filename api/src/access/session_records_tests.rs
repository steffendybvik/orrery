// The rails read a session's record (ORR-1171): what the router says on a request can only add to it.
use crate::testing::{Req, TestApi};
use serde_json::json;

/// A session's request as the router sends one when it doesn't know the session for what it is (orrery restarted).
fn plain(req: Req, session: &str) -> Req {
    req.by_agent("claude").header("orrery-actor-asked", "1").header("orrery-actor-kind", "session").header("orrery-session", session)
}

#[tokio::test]
async fn a_recorded_untrusted_session_is_held_whatever_the_router_says() {
    let api = TestApi::new().await;
    let own = api.project("Primes").await;
    let other = api.project("Sieves").await;
    api.record_session("run-1", "untrusted", Some(&own)).await;
    let elsewhere = plain(api.post(&format!("/api/projects/{other}/issues"), json!({"title": "From outside"})), "run-1").send().await;
    assert_eq!(elsewhere.status, 403, "{}", elsewhere.body);
    let here = plain(api.post(&format!("/api/projects/{own}/issues"), json!({"title": "From outside"})), "run-1").send().await;
    assert_eq!(here.status, 201, "{}", here.body);
    // Its untrusted column holds it too: no comment on the owner's issue.
    let issue = api.issue(&own, json!({"title": "Sieve"})).await;
    let comment = plain(api.post(&format!("/api/projects/{own}/issues/{issue}/comments"), json!({"body": "Hi"})), "run-1").send().await;
    assert_eq!(comment.status, 403, "{}", comment.body);
}

#[tokio::test]
async fn a_session_is_found_by_the_id_it_goes_by_after_a_clear() {
    let api = TestApi::new().await;
    let own = api.project("Primes").await;
    let other = api.project("Sieves").await;
    api.record_session("run-1", "untrusted", Some(&own)).await;
    let req = api.post(&format!("/api/projects/{other}/issues"), json!({"title": "From outside"}));
    let elsewhere = plain(req, "stale-id").header("orrery-worked-by", "run-1").send().await;
    assert_eq!(elsewhere.status, 403, "{}", elsewhere.body);
}

#[tokio::test]
async fn a_recorded_chat_is_held_to_the_chat_s_column() {
    let api = TestApi::new().await;
    let made = plain(api.post("/api/projects", json!({"name": "Primes"})), "chat-1").send().await;
    assert_eq!(made.status, 201, "a plain session makes a project: {}", made.body);
    api.record_session("chat-1", "chat", None).await;
    let refused = plain(api.post("/api/projects", json!({"name": "Sieves"})), "chat-1").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
}

#[tokio::test]
async fn an_unrecorded_session_is_as_the_router_says() {
    let api = TestApi::new().await;
    let made = plain(api.post("/api/projects", json!({"name": "Primes"})), "nobody-knows").send().await;
    assert_eq!(made.status, 201, "{}", made.body);
}
