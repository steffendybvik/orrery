// Which sessions are there to hear (ORR-1172), and the claim the rails hold with it: a session's comment edit or
// schedule request on an issue another session has started, while that one is there, is refused as the router's
// `claimFor` refused it.
use crate::testing::{from_outside, TestApi};
use serde_json::{json, Value};

/// Primes with Sieve started by session `other`, which is there to hear on Primes.
async fn held_by_other(api: &TestApi) -> (String, String) {
    let (project, issue) = api.board().await;
    let moved = api.patch(&format!("/api/projects/{project}/issues/{issue}"), json!({"status": "in-progress"})).send().await;
    assert_eq!(moved.status, 200, "{}", moved.body);
    let worked = api.post(&format!("/api/projects/{project}/issues/{issue}/worked-by"), json!({"session": "other"})).send().await;
    assert_eq!(worked.status, 204, "{}", worked.body);
    say(api, "other", json!({"projects": [project]})).await;
    (project, issue)
}

async fn say(api: &TestApi, session: &str, body: Value) {
    let reply = api.put(&format!("/api/session-presence/{session}"), body).send().await;
    assert_eq!(reply.status, 204, "{}", reply.body);
}

/// A comment's edit and a schedule request on the issue, as session `me` sends them through the router: the status each
/// came back with.
async fn writes_as(api: &TestApi, session: &str, project: &str, issue: &str, owner: bool) -> [u16; 2] {
    let as_session = |req: crate::testing::Req| {
        let req = req.header("orrery-session", session).header("orrery-actor-session", session);
        if owner {
            req
        } else {
            req.by_agent("claude")
        }
    };
    let edit = as_session(api.patch(&format!("/api/projects/{project}/issues/{issue}/comments/1"), json!({"body": "x"}))).send().await;
    let schedule = json!({"schedule": {"title": "Morning check", "kind": "message", "notes": "Look.", "cron": "0 9 * * 1-5"}, "why": "Asked."});
    let asked = as_session(api.post(&format!("/api/projects/{project}/issues/{issue}/schedule-requests"), schedule)).send().await;
    [edit.status.as_u16(), asked.status.as_u16()]
}

#[tokio::test]
async fn another_sessions_claim_holds_while_it_is_there() {
    let api = TestApi::new().await;
    let (project, issue) = held_by_other(&api).await;
    let refused = api
        .patch(&format!("/api/projects/{project}/issues/{issue}/comments/1"), json!({"body": "x"}))
        .by_agent("claude")
        .header("orrery-session", "me")
        .send()
        .await;
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert_eq!(refused.body["message"], format!("{issue} is already being worked on by another session (other); pick another issue"));
    assert_eq!(writes_as(&api, "me", &project, &issue, false).await, [409, 409]);
    // The session on it, the owner, and a request naming no session aren't held.
    assert!(!writes_as(&api, "other", &project, &issue, false).await.contains(&409));
    assert!(!writes_as(&api, "me", &project, &issue, true).await.contains(&409));
    let unnamed = api.patch(&format!("/api/projects/{project}/issues/{issue}/comments/1"), json!({"body": "x"})).by_agent("claude").send().await;
    assert_ne!(unnamed.status, 409, "{}", unnamed.body);
    // Its new id after a `/clear`, as the router names it (`Orrery-Worked-By`), is the same session.
    let renamed = api
        .patch(&format!("/api/projects/{project}/issues/{issue}/comments/1"), json!({"body": "x"}))
        .by_agent("claude")
        .header("orrery-session", "old-id")
        .header("orrery-worked-by", "other")
        .send()
        .await;
    assert_ne!(renamed.status, 409, "{}", renamed.body);
}

#[tokio::test]
async fn a_claim_lapses_once_its_session_has_gone_or_gone_quiet() {
    let api = TestApi::new().await;
    let (project, issue) = held_by_other(&api).await;
    // Gone, as its channel closed.
    assert_eq!(api.delete("/api/session-presence/other").send().await.status, 204);
    assert!(!writes_as(&api, "me", &project, &issue, false).await.contains(&409));
    // Said again, then quiet past 90 seconds: a session that died without a goodbye.
    say(&api, "other", json!({"projects": [project]})).await;
    assert_eq!(writes_as(&api, "me", &project, &issue, false).await, [409, 409]);
    let old = (chrono::Utc::now() - chrono::Duration::seconds(91)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    api.run("UPDATE session_presence SET seen_at = ?", &[&old]).await;
    assert!(!writes_as(&api, "me", &project, &issue, false).await.contains(&409));
    // There, but heard on another project only: not there for this one.
    say(&api, "other", json!({"projects": ["elsewhere"]})).await;
    assert!(!writes_as(&api, "me", &project, &issue, false).await.contains(&409));
    assert_eq!(api.count("SELECT COUNT(*) FROM session_presence").await, 1);
}

#[tokio::test]
async fn a_claim_on_an_issue_not_started_holds_nothing() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    api.post(&format!("/api/projects/{project}/issues/{issue}/worked-by"), json!({"session": "other"})).send().await;
    say(&api, "other", json!({"projects": [project]})).await;
    assert!(!writes_as(&api, "me", &project, &issue, false).await.contains(&409));
}

#[tokio::test]
async fn only_the_local_app_says_which_sessions_are_there() {
    let api = TestApi::new().await;
    let outside = from_outside(api.put("/api/session-presence/s", json!({"projects": ["p"]}))).send().await;
    assert_eq!(outside.status, 403, "{}", outside.body);
    assert_eq!(from_outside(api.delete("/api/session-presence/s")).send().await.status, 403);
    for body in [json!({}), json!({"projects": "p"}), json!({"projects": [7]}), json!({"projects": [""]})] {
        assert_eq!(api.put("/api/session-presence/s", body.clone()).send().await.status, 400, "{body}");
    }
    assert_eq!(api.count("SELECT COUNT(*) FROM session_presence").await, 0);
}
