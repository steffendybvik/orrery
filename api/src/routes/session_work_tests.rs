// The tests of routes/session_work.rs and the signals' `?waiting=` (ORR-1141), through `router()` on a database of
// their own (`crate::testing`).
use crate::testing::TestApi;
use crate::write::stamp;
use serde_json::{json, Value};

/// Ties `issue` to `session`, as `workedBy` leaves it.
async fn worked(api: &TestApi, project: &str, issue: &str, session: &str) {
    let now = stamp();
    api.run("INSERT INTO issue_sessions (project, issue, session, at, since) VALUES (?, ?, ?, ?, ?)", &[project, issue, session, &now, &now]).await;
}

/// The board's started status: the first of its kind.
async fn started(api: &TestApi) -> String {
    let reply = api.get("/api/statuses").send().await;
    reply.body.as_array().unwrap().iter().find(|s| s["kind"] == "started").unwrap()["id"].as_str().unwrap().to_string()
}

async fn start(api: &TestApi, project: &str, issue: &str) {
    let status = started(api).await;
    let reply = api.patch(&format!("/api/projects/{project}/issues/{issue}"), json!({"status": status})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
}

fn ids(reply: &Value) -> Vec<&str> {
    reply.as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn a_session_works_on_its_started_issues_with_their_latest_comment() {
    let api = TestApi::new().await;
    let (project, sieve) = api.board().await;
    let wheel = api.issue(&project, json!({"title": "Wheel"})).await;
    let other = api.issue(&project, json!({"title": "Other's"})).await;
    for issue in [&sieve, &wheel] {
        worked(&api, &project, issue, "old-id").await;
    }
    worked(&api, &project, &other, "someone").await;
    start(&api, &project, &sieve).await;
    start(&api, &project, &other).await;
    for body in ["First", "Latest"] {
        api.post(&format!("/api/projects/{project}/issues/{sieve}/comments"), json!({"body": body})).send().await;
    }
    let path = format!("/api/projects/{project}/issue-sessions?sessions=new-id,old-id");
    let reply = api.get(&path).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    // Wheel is in Todo, and Other's is someone else's.
    assert_eq!(ids(&reply.body["issues"]), [sieve.as_str()]);
    assert_eq!(reply.body["issues"][0]["last"]["body"], "Latest");
    assert_eq!(reply.body["waiting"], false);
    let none = api.get(&format!("/api/projects/{project}/issue-sessions")).send().await;
    assert_eq!(none.body, json!({"issues": [], "waiting": false, "waiting_for": false}));
    // A project that isn't there has no work on it, as the store reads it.
    assert_eq!(api.get("/api/projects/nowhere/issue-sessions?sessions=a").send().await.body["issues"], json!([]));
}

#[tokio::test]
async fn an_owners_signal_waits_for_the_session_it_was_sent_to_or_for_any() {
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    let path = format!("/api/projects/{project}/issue-sessions?sessions=sess-1");
    let send = |target: Option<&str>| {
        let mut body = json!({"kind": "message", "note": "Hi", "created_by": "owner", "owned": true});
        if let Some(target) = target {
            body["target"] = json!(target);
        }
        api.post(&format!("/api/projects/{project}/signals"), body)
    };
    send(Some("sess-2")).send().await;
    let reply = api.get(&path).send().await;
    assert_eq!((&reply.body["waiting"], &reply.body["waiting_for"]), (&json!(false), &json!(false)));
    let pooled = send(None).send().await;
    assert_eq!(pooled.status, 201, "{}", pooled.body);
    let reply = api.get(&path).send().await;
    assert_eq!((&reply.body["waiting"], &reply.body["waiting_for"]), (&json!(true), &json!(false)));
    // With no ids, what's for any session still waits.
    assert_eq!(api.get(&format!("/api/projects/{project}/issue-sessions")).send().await.body["waiting"], true);
    send(Some("sess-1")).send().await;
    let reply = api.get(&path).send().await;
    assert_eq!((&reply.body["waiting"], &reply.body["waiting_for"]), (&json!(true), &json!(true)));
}

#[tokio::test]
async fn the_workers_go_from_the_issue_up_through_its_parents() {
    let api = TestApi::new().await;
    let (project, top) = api.board().await;
    let middle = api.issue(&project, json!({"title": "Middle", "parent": top})).await;
    let leaf = api.issue(&project, json!({"title": "Leaf", "parent": middle})).await;
    start(&api, &project, &top).await;
    worked(&api, &project, &top, "sess-top").await;
    let reply = api.get(&format!("/api/projects/{project}/issues/{leaf}/workers")).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(
        reply.body,
        json!([
            {"issue": leaf, "started": false, "worker": null},
            {"issue": middle, "started": false, "worker": null},
            {"issue": top, "started": true, "worker": "sess-top"},
        ])
    );
    assert_eq!(api.get(&format!("/api/projects/{project}/issues/NOPE-9/workers")).send().await.status, 404);
}

#[tokio::test]
async fn the_dependents_are_the_issues_waiting_on_this_one() {
    let api = TestApi::new().await;
    let (project, sieve) = api.board().await;
    let after = api.issue(&project, json!({"title": "After", "depends_on": [sieve]})).await;
    let reply = api.get(&format!("/api/projects/{project}/issues/{sieve}/dependents")).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!([{"project": project, "id": after}]));
    assert_eq!(api.get(&format!("/api/projects/{project}/issues/{after}/dependents")).send().await.body, json!([]));
}

#[tokio::test]
async fn only_the_local_app_asks_which_session_is_on_which_issue() {
    let door = TestApi::at_the_door().await;
    let (project, issue) = door.board().await;
    for path in [
        format!("/api/projects/{project}/issue-sessions?sessions=a"),
        format!("/api/projects/{project}/issues/{issue}/workers"),
        format!("/api/projects/{project}/issues/{issue}/dependents"),
    ] {
        assert_eq!(door.get(&path).send().await.status, 403, "{path}");
    }
}

#[tokio::test]
async fn unheard_signals_for_the_pool_or_scheduled_are_the_last_days() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let write = |body: Value| api.post(&format!("/api/projects/{project}/signals"), body);
    write(json!({"kind": "message", "note": "Anyone", "created_by": "owner", "owned": true})).send().await;
    write(json!({"kind": "message", "note": "You", "created_by": "owner", "owned": true, "target": "sess-1"})).send().await;
    write(json!({"kind": "focus", "issue": issue, "created_by": "owner", "owned": true})).send().await;
    write(json!({"kind": "comment", "issue": issue, "created_by": "claude", "owned": false})).send().await;
    let notes =
        |reply: &Value| reply.as_array().unwrap().iter().map(|s| s["note"].as_str().unwrap_or(s["kind"].as_str().unwrap()).to_string()).collect::<Vec<_>>();
    let pooled = api.get(&format!("/api/projects/{project}/signals?waiting=pooled")).send().await;
    assert_eq!(pooled.status, 200, "{}", pooled.body);
    assert_eq!(notes(&pooled.body), ["Anyone", "focus"]);
    // The focus is on an issue with no schedule, so only the messages count.
    let scheduled = api.get(&format!("/api/projects/{project}/signals?waiting=scheduled")).send().await;
    assert_eq!(notes(&scheduled.body), ["Anyone", "You"]);
    api.run("UPDATE signals SET created_at = '2020-01-01T00:00:00.000Z' WHERE note = 'Anyone'", &[]).await;
    assert_eq!(notes(&api.get(&format!("/api/projects/{project}/signals?waiting=pooled")).send().await.body), ["focus"]);
    assert_eq!(api.get(&format!("/api/projects/{project}/signals?waiting=soon")).send().await.status, 400);
}
