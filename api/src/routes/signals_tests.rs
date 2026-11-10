// The tests of routes/signals.rs (ORR-1087), through `router()` on a database of their own (`crate::testing`).
use super::after_of;
use crate::testing::TestApi;
use serde_json::{json, Value};

/// A signal as the Nuxt server writes one: about `issue`, or about nothing.
async fn signal(api: &TestApi, project: &str, kind: &str, issue: Option<&str>, at: &str) {
    match issue {
        Some(issue) => {
            api.run("INSERT INTO signals (project, issue, kind, created_by, owned, created_at) VALUES (?, ?, ?, 'claude', 0, ?)", &[project, issue, kind, at])
                .await
        }
        None => api.run("INSERT INTO signals (project, kind, created_by, owned, created_at) VALUES (?, ?, 'claude', 0, ?)", &[project, kind, at]).await,
    }
}

fn kinds(reply: &Value) -> Vec<&str> {
    reply.as_array().unwrap().iter().map(|s| s["kind"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn signals_after_an_id_come_oldest_first() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    signal(&api, &project, "focus", Some(&issue), "2026-11-10T10:00:00.000Z").await;
    signal(&api, &project, "message", None, "2026-11-10T10:01:00.000Z").await;
    signal(&api, &project, "comment", Some(&issue), "2026-11-10T10:02:00.000Z").await;
    let all = api.get(&format!("/api/projects/{project}/signals")).send().await;
    assert_eq!(all.status, 200, "{}", all.body);
    assert_eq!(kinds(&all.body), ["focus", "message", "comment"]);
    let first = all.body[0]["id"].as_i64().unwrap();
    let later = api.get(&format!("/api/projects/{project}/signals?after={first}")).send().await;
    assert_eq!(kinds(&later.body), ["message", "comment"]);
    // Anything that isn't a number reads as 0, as `Number(…) || 0` has it.
    assert_eq!(kinds(&api.get(&format!("/api/projects/{project}/signals?after=soon")).send().await.body), ["focus", "message", "comment"]);
}

#[tokio::test]
async fn a_signal_reads_as_signal_of_gives_it() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    api.run(
        "INSERT INTO signals (project, issue, kind, note, via, target, delivered_to, instructions, person, model, created_by, owned, created_at) \
         VALUES (?, ?, 'message', 'Look', 'chat', 'sess-1', '[\"orrery · Frøy\"]', '[\"Be brief\"]', '', 'opus', 'owner', 1, '2026-11-10T10:00:00.000Z')",
        &[&project, &issue],
    )
    .await;
    let reply = api.get(&format!("/api/projects/{project}/signals")).send().await;
    let signal = &reply.body[0];
    assert_eq!(
        signal,
        &json!({"id": signal["id"], "project": project, "issue": issue, "kind": "message", "note": "Look", "via": "chat", "target": "sess-1",
            "delivered_to": ["orrery · Frøy"], "instructions": ["Be brief"], "model": "opus", "created_by": "owner", "protected": true,
            "created_at": "2026-11-10T10:00:00.000Z"})
    );
}

#[tokio::test]
async fn about_an_issue_gives_its_latest_and_an_issue_there_isnt_has_none() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    signal(&api, &project, "focus", Some(&issue), "2026-11-10T10:00:00.000Z").await;
    signal(&api, &project, "message", None, "2026-11-10T10:01:00.000Z").await;
    signal(&api, &project, "comment", Some(&issue), "2026-11-10T10:02:00.000Z").await;
    let about = api.get(&format!("/api/projects/{project}/signals?issue={issue}&after=99")).send().await;
    assert_eq!(kinds(&about.body), ["focus", "comment"]);
    let none = api.get(&format!("/api/projects/{project}/signals?issue=NOPE-9")).send().await;
    assert_eq!(none.status, 200);
    assert_eq!(none.body, json!([]));
    let milestone = api.get(&format!("/api/projects/{project}/signals?milestone=7")).send().await;
    assert_eq!(milestone.status, 200);
    assert_eq!(milestone.body, json!([]));
}

#[tokio::test]
async fn a_project_there_isnt_is_a_404() {
    let api = TestApi::new().await;
    let reply = api.get("/api/projects/nowhere/signals").send().await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.body["message"], "No project \"nowhere\"");
}

#[test]
fn after_reads_as_number_does() {
    assert_eq!(after_of(None), 0.0);
    assert_eq!(after_of(Some(" 12 ")), 12.0);
    assert_eq!(after_of(Some("nan")), 0.0);
    assert_eq!(after_of(Some("inf")), 0.0);
    assert_eq!(after_of(Some("Infinity")), f64::INFINITY);
}
