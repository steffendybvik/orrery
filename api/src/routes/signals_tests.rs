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

#[tokio::test]
async fn the_last_signal_is_the_projects_latest_and_0_before_its_first() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let none = api.get(&format!("/api/projects/{project}/signals/last")).send().await;
    assert_eq!(none.status, 200, "{}", none.body);
    assert_eq!(none.body, json!({"id": 0}));
    signal(&api, &project, "focus", Some(&issue), "2026-11-10T10:00:00.000Z").await;
    signal(&api, &project, "message", None, "2026-11-10T10:01:00.000Z").await;
    let all = api.get(&format!("/api/projects/{project}/signals")).send().await;
    let latest = all.body[1]["id"].as_i64().unwrap();
    assert_eq!(api.get(&format!("/api/projects/{project}/signals/last")).send().await.body, json!({"id": latest}));
    // Another project's signals aren't this one's.
    let other = api.project("Composites").await;
    assert_eq!(api.get(&format!("/api/projects/{other}/signals/last")).send().await.body, json!({"id": 0}));
    let nowhere = api.get("/api/projects/nowhere/signals/last").send().await;
    assert_eq!(nowhere.status, 404);
}

#[tokio::test]
async fn the_local_app_writes_a_signal_with_its_target_picked() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let sent = json!({"issue": issue, "kind": "focus", "note": "Look", "target": "sess-1", "person": "ada", "instructions": ["Be brief"],
        "model": "opus", "created_by": "owner", "owned": true});
    let reply = api.post(&format!("/api/projects/{project}/signals"), sent).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let signal = &reply.body;
    assert_eq!(
        signal,
        &json!({"id": signal["id"], "project": project, "issue": issue, "kind": "focus", "note": "Look", "target": "sess-1", "delivered_to": [],
            "instructions": ["Be brief"], "person": "ada", "model": "opus", "created_by": "owner", "protected": true, "created_at": signal["created_at"]})
    );
    // A milestone's, an epic's and a schedule's ask carry what they're about too, and read back as written.
    let milestone = api
        .post(&format!("/api/projects/{project}/signals"), json!({"milestone": "all", "status": "todo", "epic": 3, "kind": "focus", "created_by": "claude"}))
        .send()
        .await;
    assert_eq!(milestone.status, 201, "{}", milestone.body);
    assert_eq!(
        (milestone.body["milestone"].clone(), milestone.body["epic"].clone(), milestone.body["protected"].clone()),
        (json!("all"), json!(3), json!(false))
    );
    let read = api.get(&format!("/api/projects/{project}/signals")).send().await;
    assert_eq!(read.body, json!([signal, milestone.body]));
}

#[tokio::test]
async fn a_signal_is_refused_from_anyone_but_the_local_app_or_when_it_says_nothing_usable() {
    let door = TestApi::at_the_door().await;
    let (project, _) = door.board().await;
    let reply = door.post(&format!("/api/projects/{project}/signals"), json!({"kind": "message", "created_by": "owner"})).send().await;
    assert_eq!(reply.status, 403, "{}", reply.body);
    for path in [format!("/api/projects/{project}/signals/1/receipts"), format!("/api/projects/{project}/signals/retarget"), "/api/signals/prune".into()] {
        assert_eq!(door.post(&path, json!({})).send().await.status, 403, "{path}");
    }
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    let path = format!("/api/projects/{project}/signals");
    let wrong = api.post(&path, json!({"kind": "shout", "created_by": "owner"})).send().await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.body["message"], "\"kind\" is \"shout\"; use focus, comment, message");
    assert_eq!(api.post(&path, json!({"kind": "message"})).send().await.status, 400);
    assert_eq!(api.post(&path, json!({"kind": "message", "created_by": "owner", "epic": "three"})).send().await.status, 400);
    assert_eq!(api.post(&path, json!({"kind": "message", "created_by": "owner", "instructions": [1]})).send().await.status, 400);
    assert_eq!(api.post("/api/projects/nowhere/signals", json!({"kind": "message", "created_by": "owner"})).send().await.status, 404);
}

#[tokio::test]
async fn a_receipt_adds_the_session_once_and_a_signal_there_isnt_is_a_404() {
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    let written =
        api.post(&format!("/api/projects/{project}/signals"), json!({"kind": "message", "note": "Hi", "created_by": "owner", "owned": true})).send().await;
    let id = written.body["id"].as_i64().unwrap();
    let path = format!("/api/projects/{project}/signals/{id}/receipts");
    for (to, heard) in [("Frøy", json!(["Frøy"])), ("Siv", json!(["Frøy", "Siv"])), ("Frøy", json!(["Frøy", "Siv"]))] {
        let reply = api.post(&path, json!({"to": to})).send().await;
        assert_eq!(reply.status, 200, "{}", reply.body);
        assert_eq!(reply.body["delivered_to"], heard, "{to}");
    }
    assert_eq!(api.get(&format!("/api/projects/{project}/signals")).send().await.body[0]["delivered_to"], json!(["Frøy", "Siv"]));
    let missing = api.post(&format!("/api/projects/{project}/signals/999/receipts"), json!({"to": "Siv"})).send().await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.body["message"], format!("No signal 999 in {project}"));
    assert_eq!(api.post(&format!("/api/projects/{project}/signals/soon/receipts"), json!({"to": "Siv"})).send().await.status, 404);
    assert_eq!(api.post(&path, json!({})).send().await.status, 400);
}

#[tokio::test]
async fn a_new_session_id_takes_over_its_old_ones_signals_and_old_signals_go() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    for target in ["old", "old", "other"] {
        api.post(&format!("/api/projects/{project}/signals"), json!({"kind": "message", "target": target, "created_by": "owner"})).send().await;
    }
    let moved = api.post(&format!("/api/projects/{project}/signals/retarget"), json!({"from": "old", "to": "new"})).send().await;
    assert_eq!(moved.body, json!({"moved": 2}));
    let targets: Vec<Value> =
        api.get(&format!("/api/projects/{project}/signals")).send().await.body.as_array().unwrap().iter().map(|s| s["target"].clone()).collect();
    assert_eq!(targets, [json!("new"), json!("new"), json!("other")]);
    signal(&api, &project, "focus", Some(&issue), "2026-01-01T00:00:00.000Z").await;
    assert_eq!(api.post("/api/signals/prune", json!({})).send().await.body, json!({"pruned": 1}));
    assert_eq!(api.get(&format!("/api/projects/{project}/signals")).send().await.body.as_array().unwrap().len(), 3);
}

#[test]
fn after_reads_as_number_does() {
    assert_eq!(after_of(None), 0.0);
    assert_eq!(after_of(Some(" 12 ")), 12.0);
    assert_eq!(after_of(Some("nan")), 0.0);
    assert_eq!(after_of(Some("inf")), 0.0);
    assert_eq!(after_of(Some("Infinity")), f64::INFINITY);
}

#[tokio::test]
async fn focused_gives_the_owners_focus_from_the_last_day_heard_or_not() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let now = chrono::Utc::now();
    let at = |hours: i64| (now - chrono::Duration::hours(hours)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let focus = |owned: &str, target: &str, delivered: &str, created: String| {
        let (project, issue) = (project.clone(), issue.clone());
        let api = &api;
        let (owned, target, delivered) = (owned.to_string(), target.to_string(), delivered.to_string());
        async move {
            api.run(
                "INSERT INTO signals (project, issue, kind, target, delivered_to, created_by, owned, created_at) VALUES (?, ?, 'focus', NULLIF(?, ''), ?, 'owner', CAST(? AS INTEGER), ?)",
                &[&project, &issue, &target, &delivered, &owned, &created],
            )
            .await
        }
    };
    let path = |query: &str| format!("/api/projects/{project}/signals?focused={issue}{query}");
    assert_eq!(api.get(&path("")).send().await.body, json!([]), "none yet");
    focus("0", "", "[]", at(1)).await;
    focus("1", "", "[]", at(30)).await;
    assert_eq!(api.get(&path("")).send().await.body, json!([]), "a member's, and the owner's from over a day ago, don't count");
    focus("1", "sess-1", "[\"orrery · Saga\"]", at(2)).await;
    assert_eq!(api.get(&path("")).send().await.body.as_array().unwrap().len(), 1, "heard or not");
    assert_eq!(api.get(&path("&target=sess-1")).send().await.body.as_array().unwrap().len(), 1);
    assert_eq!(api.get(&path("&target=sess-2")).send().await.body, json!([]), "aimed at another session");
    assert_eq!(api.get(&format!("/api/projects/{project}/signals?focused=NOPE-9")).send().await.body, json!([]), "an issue there isn't has none");
}
