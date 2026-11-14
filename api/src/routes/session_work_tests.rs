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
        format!("/api/projects/{project}/session-work"),
        format!("/api/projects/{project}/comments/unanswered"),
    ] {
        assert_eq!(door.get(&path).send().await.status, 403, "{path}");
    }
    assert_eq!(door.post(&format!("/api/projects/{project}/issues/{issue}/worked-by"), json!({"session": "a"})).send().await.status, 403);
    assert_eq!(door.post(&format!("/api/projects/{project}/issue-sessions/rename"), json!({"from": "a", "to": "b"})).send().await.status, 403);
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

#[tokio::test]
async fn working_an_issue_ties_it_to_the_session_and_keeps_since_while_its_the_same_one() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let path = format!("/api/projects/{project}/issues/{issue}/worked-by");
    let since = || async {
        sqlx::query_scalar::<_, String>(&crate::db::sql("SELECT session || ' ' || since FROM issue_sessions WHERE project = ? AND issue = ?"))
            .bind(&project)
            .bind(&issue)
            .fetch_one(&api.app.pool)
            .await
            .unwrap()
    };
    assert_eq!(api.post(&path, json!({"session": "sess-1"})).send().await.status, 204);
    let first = since().await;
    assert!(first.starts_with("sess-1 "), "{first}");
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    api.post(&path, json!({"session": "sess-1"})).send().await;
    assert_eq!(since().await, first, "the same session keeps when it took the issue");
    api.post(&path, json!({"session": "sess-2"})).send().await;
    let second = since().await;
    assert!(second.starts_with("sess-2 ") && second != first.replace("sess-1", "sess-2"), "{second}");
    // An issue there isn't is let be, and a session must be named.
    assert_eq!(api.post(&format!("/api/projects/{project}/issues/NOPE-9/worked-by"), json!({"session": "sess-1"})).send().await.status, 204);
    assert_eq!(api.count("SELECT COUNT(*) FROM issue_sessions").await, 1);
    assert_eq!(api.post(&path, json!({})).send().await.status, 400);
}

#[tokio::test]
async fn a_sessions_new_id_takes_over_the_issues_its_old_one_worked() {
    let api = TestApi::new().await;
    let (project, sieve) = api.board().await;
    let wheel = api.issue(&project, json!({"title": "Wheel"})).await;
    let other = api.issue(&project, json!({"title": "Other's"})).await;
    worked(&api, &project, &sieve, "old-id").await;
    worked(&api, &project, &wheel, "old-id").await;
    worked(&api, &project, &other, "someone").await;
    let path = format!("/api/projects/{project}/issue-sessions/rename");
    let reply = api.post(&path, json!({"from": "old-id", "to": "new-id"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!({"moved": 2}));
    assert_eq!(api.count("SELECT COUNT(*) FROM issue_sessions WHERE session = 'new-id'").await, 2);
    assert_eq!(api.count("SELECT COUNT(*) FROM issue_sessions WHERE session = 'someone'").await, 1);
    // Again, nothing is left under the old id; and both ids must be named.
    assert_eq!(api.post(&path, json!({"from": "old-id", "to": "new-id"})).send().await.body, json!({"moved": 0}));
    assert_eq!(api.post(&path, json!({"from": "old-id"})).send().await.status, 400);
    assert_eq!(api.post(&path, json!({"from": "", "to": "x"})).send().await.status, 400);
}

#[tokio::test]
async fn a_focus_is_on_its_way_while_its_unheard_and_from_the_last_ten_minutes() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let other = api.issue(&project, json!({"title": "Other"})).await;
    let path = format!("/api/projects/{project}/signals?waiting=focus&issue={issue}");
    let on_its_way = || async { api.get(&path).send().await.body.as_array().unwrap().len() };
    let write = |body: Value| api.post(&format!("/api/projects/{project}/signals"), body);
    // A session's own focus, a comment and a focus on another issue don't count.
    write(json!({"kind": "focus", "issue": issue, "created_by": "claude", "owned": false})).send().await;
    write(json!({"kind": "comment", "issue": issue, "created_by": "owner", "owned": true})).send().await;
    write(json!({"kind": "focus", "issue": other, "created_by": "owner", "owned": true})).send().await;
    assert_eq!(on_its_way().await, 0);
    let sent = write(json!({"kind": "focus", "issue": issue, "created_by": "owner", "owned": true})).send().await;
    assert_eq!(sent.status, 201, "{}", sent.body);
    assert_eq!(on_its_way().await, 1);
    // A member's counts too.
    write(json!({"kind": "focus", "issue": issue, "created_by": "ann", "owned": false, "person": "ann"})).send().await;
    assert_eq!(on_its_way().await, 2);
    api.run("UPDATE signals SET delivered_to = '[\"sess-1\"]' WHERE person = 'ann'", &[]).await;
    assert_eq!(on_its_way().await, 1);
    api.run("UPDATE signals SET created_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'focus'", &[]).await;
    assert_eq!(on_its_way().await, 0);
    // An issue there isn't has none, and `focus` needs an issue.
    assert_eq!(api.get(&format!("/api/projects/{project}/signals?waiting=focus&issue=NOPE-9")).send().await.body, json!([]));
    assert_eq!(api.get(&format!("/api/projects/{project}/signals?waiting=focus")).send().await.status, 400);
}

/// `?sessions=` as the local app sends it: the JSON list, percent-encoded.
fn work_path(project: &str, sessions: Value) -> String {
    let text = sessions.to_string();
    format!("/api/projects/{project}/session-work?sessions={}", percent_encoding::utf8_percent_encode(&text, percent_encoding::NON_ALPHANUMERIC))
}

#[tokio::test]
async fn each_session_is_on_the_open_issues_it_worked_and_the_signals_that_went_to_it() {
    let api = TestApi::new().await;
    let (project, sieve) = api.board().await;
    let wheel = api.issue(&project, json!({"title": "Wheel"})).await;
    let shipped = api.issue(&project, json!({"title": "Shipped"})).await;
    let idea = api.issue(&project, json!({"title": "Idea", "proposal": "pending"})).await;
    let theirs = api.issue(&project, json!({"title": "Theirs"})).await;
    for issue in [&sieve, &wheel, &shipped, &idea] {
        worked(&api, &project, issue, "old-id").await;
    }
    worked(&api, &project, &theirs, "other").await;
    start(&api, &project, &sieve).await;
    let done = api.get("/api/statuses").send().await.body.as_array().unwrap().iter().find(|s| s["kind"] == "done").unwrap()["id"].clone();
    api.patch(&format!("/api/projects/{project}/issues/{shipped}"), json!({"status": done})).send().await;
    let send = |body: Value| api.post(&format!("/api/projects/{project}/signals"), body);
    let mine = send(json!({"kind": "message", "note": "To me", "created_by": "owner", "owned": true, "target": "old-id"})).send().await.body["id"].clone();
    let everyone = send(json!({"kind": "message", "note": "To all", "created_by": "owner", "owned": true})).send().await.body["id"].clone();
    send(json!({"kind": "message", "note": "Unheard by me", "created_by": "owner", "owned": true})).send().await;
    send(json!({"kind": "message", "note": "To them", "created_by": "owner", "owned": true, "target": "other"})).send().await;
    let heard = api.post(&format!("/api/projects/{project}/signals/{everyone}/receipts"), json!({"to": "Ada"})).send().await;
    assert_eq!(heard.status, 200, "{}", heard.body);

    let reply =
        api.get(&work_path(&project, json!([{"id": "new-id", "name": "Ada", "ids": ["new-id", "old-id"]}, {"id": "other", "name": "Bo"}]))).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let ada = &reply.body["new-id"];
    // Shipped is closed and Idea a proposal; Theirs is another session's.
    let mut on: Vec<&str> = ada["issues"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
    on.sort();
    let mut want = vec![sieve.as_str(), wheel.as_str()];
    want.sort();
    assert_eq!(on, want);
    let first = &ada["issues"][0];
    for field in ["id", "title", "column", "kind", "since"] {
        assert!(first.get(field).is_some(), "{field} in {first}");
    }
    // Newest first: the one to it by an old id, and the one to everyone it heard by name.
    let notes: Vec<&str> = ada["signals"].as_array().unwrap().iter().map(|s| s["note"].as_str().unwrap()).collect();
    assert_eq!(notes, ["To all", "To me"]);
    assert_eq!(ada["signals"][1]["id"], mine);
    assert_eq!(reply.body["other"]["issues"][0]["id"], theirs.as_str(), "its own id, when it sends no ids");
    assert_eq!(reply.body["other"]["signals"][0]["note"], "To them");
}

#[tokio::test]
async fn a_session_hears_its_five_latest_signals() {
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    for n in 0..7 {
        api.post(
            &format!("/api/projects/{project}/signals"),
            json!({"kind": "message", "note": format!("{n}"), "created_by": "owner", "owned": true, "target": "s"}),
        )
        .send()
        .await;
    }
    let reply = api.get(&work_path(&project, json!([{"id": "s", "name": "S"}]))).send().await;
    let notes: Vec<&str> = reply.body["s"]["signals"].as_array().unwrap().iter().map(|s| s["note"].as_str().unwrap()).collect();
    assert_eq!(notes, ["6", "5", "4", "3", "2"]);
}

#[tokio::test]
async fn the_sessions_work_needs_a_project_there_is_and_sessions_as_a_list() {
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    assert_eq!(api.get(&work_path("nowhere", json!([]))).send().await.status, 404);
    assert_eq!(api.get(&format!("/api/projects/{project}/session-work?sessions=a,b")).send().await.status, 400);
    assert_eq!(api.get(&format!("/api/projects/{project}/session-work")).send().await.body, json!({}));
}

/// A comment on `issue`, as the store writes one: `who` by, `owned` the owner's, `person` a member's (not an agent's).
async fn said(api: &TestApi, project: &str, issue: &str, body: &str, who: &str, owned: bool, person: Option<&str>) {
    let now = stamp();
    // `owned` goes in the text, as Postgres takes no text for an integer column.
    let text = format!(
        "INSERT INTO comments (project, issue, body, created_by, owned, person, by_agent, created_at, updated_at) VALUES (?, ?, ?, ?, {}, NULLIF(?, ''), 0, ?, ?)",
        u8::from(owned)
    );
    api.run(&text, &[project, issue, body, who, person.unwrap_or(""), &now, &now]).await;
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
}

#[tokio::test]
async fn the_owners_unanswered_comments_are_those_no_agent_answered_nor_session_had() {
    let api = TestApi::new().await;
    let (project, sieve) = api.board().await;
    let answered = api.issue(&project, json!({"title": "Answered"})).await;
    let heard = api.issue(&project, json!({"title": "Heard"})).await;
    let anns = api.issue(&project, json!({"title": "Ann's"})).await;
    api.run("UPDATE issues SET assignee = 'Ann' WHERE id = ?", &[&anns]).await;
    let path = format!("/api/projects/{project}/comments/unanswered");
    let bodies = |reply: &Value| reply.as_array().unwrap().iter().map(|c| c["body"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(api.get(&path).send().await.body, json!([]));
    said(&api, &project, &sieve, "Still waiting", "owner", true, None).await;
    // orrery's own word after it (a pull request's news) answers nothing.
    said(&api, &project, &sieve, "PR merged", "orrery", false, None).await;
    said(&api, &project, &answered, "Answer me", "owner", true, None).await;
    said(&api, &project, &answered, "Done", "claude", false, None).await;
    said(&api, &project, &heard, "Heard me", "owner", true, None).await;
    api.post(&format!("/api/projects/{project}/signals"), json!({"kind": "comment", "issue": heard, "created_by": "owner", "owned": true, "target": "sess-1"}))
        .send()
        .await;
    api.run("UPDATE signals SET delivered_to = '[\"Tor\"]'", &[]).await;
    said(&api, &project, &anns, "Ann asks", "ann", false, Some("ann")).await;
    let reply = api.get(&path).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!([{"issue": sieve, "body": "Still waiting", "created_by": "owner", "owned": true, "assignee": null}]));
    // A member's own words count for their session, on what's theirs.
    assert_eq!(bodies(&api.get(&format!("{path}?person=ann")).send().await.body), ["Still waiting", "Ann asks"]);
    // One older than the signals kept isn't carried.
    api.run("UPDATE comments SET created_at = '2020-01-01T00:00:00.000Z' WHERE body = 'Still waiting'", &[]).await;
    assert_eq!(api.get(&path).send().await.body, json!([]));
}
