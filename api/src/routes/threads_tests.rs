// The tests of routes/threads.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};

/// A project with milestone 1 on it, and epic 1: the project's id.
async fn board(api: &TestApi) -> String {
    let project = api.project("Primes").await;
    assert_eq!(api.post(&format!("/api/projects/{project}/milestones"), json!({"title": "Sieve"})).send().await.status, 201);
    assert_eq!(api.post("/api/epics", json!({"title": "Wheels"})).send().await.status, 201);
    project
}

async fn comment(api: &TestApi, path: &str, body: &str) -> Value {
    let reply = api.post(path, json!({"body": body})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    reply.body
}

#[tokio::test]
async fn a_comment_on_a_milestone_says_its_project_changed_and_is_listed_oldest_first() {
    let api = TestApi::new().await;
    let project = board(&api).await;
    let path = format!("/api/projects/{project}/milestones/1/comments");
    let reply = api.post(&path, json!({"body": "Oiled."})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["project"], json!(project));
    assert_eq!(reply.body["milestone"], "1");
    assert_eq!(reply.body["body"], "Oiled.");
    assert_eq!(reply.body["created_by"], "owner");
    assert_eq!(reply.body["protected"], true);
    assert!(reply.body.get("epic").is_none());
    assert_eq!(reply.header("orrery-changed"), Some(project.as_str()));
    assert_eq!(reply.header("orrery-told"), None, "a thread's comment asks nothing and wakes nobody");
    assert_eq!(reply.header("orrery-epics"), None);
    comment(&api, &path, "Again.").await;
    let listed = api.get(&path).send().await;
    assert_eq!(listed.status, 200);
    let bodies: Vec<&str> = listed.body.as_array().unwrap().iter().map(|c| c["body"].as_str().unwrap()).collect();
    assert_eq!(bodies, ["Oiled.", "Again."]);
    assert_eq!(listed.body[0], reply.body);
}

#[tokio::test]
async fn a_comment_on_an_epic_says_the_epics_changed() {
    let api = TestApi::new().await;
    board(&api).await;
    let reply = api.post("/api/epics/1/comments", json!({"body": "Round."})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["epic"], 1);
    assert!(reply.body.get("project").is_none());
    assert_eq!(reply.header("orrery-epics"), Some("1"));
    assert_eq!(reply.header("orrery-changed"), None);
    assert_eq!(api.get("/api/epics/EPC-1/comments").send().await.body, json!([reply.body]));
}

#[tokio::test]
async fn a_comment_is_edited_and_deleted() {
    let api = TestApi::new().await;
    let project = board(&api).await;
    for path in [format!("/api/projects/{project}/milestones/1/comments"), "/api/epics/1/comments".to_string()] {
        let id = comment(&api, &path, "First.").await["id"].as_i64().unwrap();
        let edited = api.patch(&format!("{path}/{id}"), json!({"body": "Second."})).send().await;
        assert_eq!(edited.status, 200, "{path}: {}", edited.body);
        assert_eq!(edited.body["body"], "Second.");
        assert_eq!(api.patch(&format!("{path}/{id}"), json!({})).send().await.status, 200, "{path}: nothing to change is fine");
        assert_eq!(api.get(&path).send().await.body[0]["body"], "Second.");
        let gone = api.delete(&format!("{path}/{id}")).send().await;
        assert_eq!(gone.status, 204, "{path}: {}", gone.body);
        assert_eq!(api.get(&path).send().await.body, json!([]));
        assert_eq!(api.delete(&format!("{path}/{id}")).send().await.status, 404);
    }
}

#[tokio::test]
async fn a_bad_comment_is_refused_with_its_problems() {
    let api = TestApi::new().await;
    let project = board(&api).await;
    for path in [format!("/api/projects/{project}/milestones/1/comments"), "/api/epics/1/comments".to_string()] {
        let missing = api.post(&path, json!({})).send().await;
        assert_eq!(missing.status, 400);
        assert_eq!(missing.body["data"]["problems"], json!(["missing \"body\""]));
        let wrong = api.post(&path, json!({"body": 3, "asks": "decision"})).send().await;
        assert_eq!(wrong.status, 400);
        assert_eq!(wrong.body["data"]["problems"].as_array().unwrap().len(), 2, "{}", wrong.body);
        assert_eq!(api.post(&path, json!({"body": "   "})).send().await.status, 400);
        let id = comment(&api, &path, "Kept.").await["id"].as_i64().unwrap();
        assert_eq!(api.patch(&format!("{path}/{id}"), json!({"body": null})).send().await.status, 400);
        assert_eq!(api.get(&path).send().await.body[0]["body"], "Kept.");
    }
}

#[tokio::test]
async fn comments_on_what_is_not_there_are_not_found() {
    let api = TestApi::new().await;
    let project = board(&api).await;
    let id = comment(&api, &format!("/api/projects/{project}/milestones/1/comments"), "Here.").await["id"].as_i64().unwrap();
    for reply in [
        api.get("/api/projects/nope/milestones/1/comments").send().await,
        api.get(&format!("/api/projects/{project}/milestones/9/comments")).send().await,
        api.post(&format!("/api/projects/{project}/milestones/9/comments"), json!({"body": "x"})).send().await,
        api.get("/api/epics/9/comments").send().await,
        api.post("/api/epics/9/comments", json!({"body": "x"})).send().await,
        api.patch(&format!("/api/projects/{project}/milestones/1/comments/abc"), json!({"body": "x"})).send().await,
        api.delete(&format!("/api/projects/{project}/milestones/1/comments/1.5")).send().await,
        api.patch(&format!("/api/projects/{project}/milestones/1/comments/999"), json!({"body": "x"})).send().await,
        // A milestone's comment isn't the epic's, though their ids may be the same.
        api.patch(&format!("/api/epics/1/comments/{id}"), json!({"body": "x"})).send().await,
        api.delete(&format!("/api/epics/1/comments/{id}")).send().await,
    ] {
        assert_eq!(reply.status, 404, "{}", reply.body);
    }
}

#[tokio::test]
async fn an_agent_leaves_the_owner_s_comments_alone() {
    let api = TestApi::new().await;
    let project = board(&api).await;
    for (path, permission) in
        [(format!("/api/projects/{project}/milestones/1/comments"), "comments.write"), ("/api/epics/1/comments".to_string(), "epics.comment")]
    {
        let id = comment(&api, &path, "Mine.").await["id"].as_i64().unwrap();
        let edit = api.patch(&format!("{path}/{id}"), json!({"body": "Theirs."})).by_agent("claude").send().await;
        assert_eq!(edit.status, 403, "{path}: {}", edit.body);
        assert_eq!(edit.body["data"]["permission"], permission);
        let delete = api.delete(&format!("{path}/{id}")).by_agent("claude").send().await;
        assert_eq!(delete.status, 403);
        assert_eq!(api.get(&path).send().await.body[0]["body"], "Mine.");
    }
}

#[tokio::test]
async fn an_agent_s_comment_names_its_session_and_is_its_to_change() {
    let api = TestApi::new().await;
    let project = board(&api).await;
    let path = format!("/api/projects/{project}/milestones/1/comments");
    let reply = api.post(&path, json!({"body": "Started."})).by_agent("claude").header("orrery-actor-session", "orr-7").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["created_by"], "claude");
    assert_eq!(reply.body["session_name"], "orr-7");
    assert_eq!(reply.body["protected"], false);
    let id = reply.body["id"].as_i64().unwrap();
    assert_eq!(api.patch(&format!("{path}/{id}"), json!({"body": "Done."})).by_agent("claude").send().await.status, 200);
    assert_eq!(api.delete(&format!("{path}/{id}")).send().await.status, 204, "the owner changes anyone's");
}

#[tokio::test]
async fn a_member_s_comment_is_theirs_and_the_owner_s_to_change() {
    let api = TestApi::new().await;
    board(&api).await;
    let path = "/api/epics/1/comments";
    let reply = api.post(path, json!({"body": "Ann's."})).by_agent("ann").header("orrery-actor-person", "ann").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let id = reply.body["id"].as_i64().unwrap();
    let other = api.patch(&format!("{path}/{id}"), json!({"body": "Not theirs."})).by_agent("claude").send().await;
    assert_eq!(other.status, 403, "{}", other.body);
    let bob = api.delete(&format!("{path}/{id}")).by_agent("bob").header("orrery-actor-person", "bob").send().await;
    assert_eq!(bob.status, 403, "{}", bob.body);
    let own = api.patch(&format!("{path}/{id}"), json!({"body": "Still Ann's."})).by_agent("ann").header("orrery-actor-person", "ann").send().await;
    assert_eq!(own.status, 200, "{}", own.body);
    assert_eq!(api.delete(&format!("{path}/{id}")).send().await.status, 204);
}
