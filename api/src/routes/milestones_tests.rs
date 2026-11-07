// The tests of routes/milestones.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{Reply, TestApi};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use sqlx::Row;

/// What a reply's `orrery-told` says, decoded, each event in turn.
fn told(reply: &Reply) -> Vec<String> {
    reply.header("orrery-told").map(|t| t.split(", ").map(|e| percent_decode_str(e).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default()
}

async fn milestone(api: &TestApi, project: &str, body: Value) -> Value {
    let reply = api.post(&format!("/api/projects/{project}/milestones"), body).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    reply.body
}

#[tokio::test]
async fn a_new_milestone_takes_the_project_s_next_number() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let reply =
        api.post(&format!("/api/projects/{project}/milestones"), json!({"title": " Sieve ", "summary": "The first ones", "priority": "P1"})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["id"], "1");
    assert_eq!(reply.body["title"], "Sieve");
    assert_eq!(reply.body["summary"], "The first ones");
    assert_eq!(reply.body["priority"], "P1");
    assert_eq!(reply.body["issues"], json!([]));
    assert_eq!(reply.body["tasks"], json!([]));
    assert_eq!(reply.body["protected"], true);
    assert!(reply.body["full_id"].as_str().unwrap().starts_with("MLS-1-"), "{}", reply.body);
    assert_eq!(reply.header("orrery-changed"), Some(project.as_str()));
    assert_eq!(told(&reply), [format!("milestone.created {project} 1")]);
    assert_eq!(milestone(&api, &project, json!({"title": "Wheel"})).await["id"], "2");
    assert_eq!(api.get(&format!("/api/projects/{project}/milestones/1")).send().await.body, reply.body);
}

#[tokio::test]
async fn the_milestones_are_listed_in_order_with_their_issues() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    milestone(&api, &project, json!({"title": "Later"})).await;
    milestone(&api, &project, json!({"title": "First", "position": -1})).await;
    let issue = api.issue(&project, json!({"title": "Sieve", "milestone": "1"})).await;
    let listed = api.get(&format!("/api/projects/{project}/milestones")).send().await;
    assert_eq!(listed.status, 200);
    let list = listed.body.as_array().unwrap();
    assert_eq!(list.iter().map(|m| m["title"].as_str().unwrap()).collect::<Vec<_>>(), ["First", "Later"], "{}", listed.body);
    assert_eq!(list[1]["issues"], json!([issue]));
    assert!(list[1].get("tasks").is_none(), "the list names its issues; one milestone has them whole");
    let one = api.get(&format!("/api/projects/{project}/milestones/1")).send().await;
    assert_eq!(one.body["tasks"][0]["id"], json!(issue));
}

#[tokio::test]
async fn a_milestone_is_read_by_its_full_id() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let made = milestone(&api, &project, json!({"title": "Sieve"})).await;
    let full = made["full_id"].as_str().unwrap();
    let read = api.get(&format!("/api/projects/{project}/milestones/{full}")).send().await;
    assert_eq!(read.status, 200, "{}", read.body);
    assert_eq!(read.body["id"], "1");
}

#[tokio::test]
async fn a_new_title_or_summary_tells_the_milestone_changed_and_a_move_does_not() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    milestone(&api, &project, json!({"title": "Sieve", "priority": "P2"})).await;
    let path = format!("/api/projects/{project}/milestones/1");
    let reworded = api.patch(&path, json!({"title": " Sieve of Eratosthenes ", "priority": null})).send().await;
    assert_eq!(reworded.status, 200, "{}", reworded.body);
    assert_eq!(reworded.body["title"], "Sieve of Eratosthenes");
    assert!(reworded.body.get("priority").is_none_or(Value::is_null), "{}", reworded.body);
    assert_eq!(told(&reworded), [format!("milestone.changed {project} 1")]);
    let moved = api.patch(&path, json!({"position": 5, "priority": "P0"})).send().await;
    assert_eq!(moved.status, 200);
    assert_eq!(moved.body["priority"], "P0");
    assert_eq!(moved.header("orrery-told"), None);
    assert_eq!(moved.header("orrery-changed"), Some(project.as_str()));
}

#[tokio::test]
async fn a_bad_milestone_is_refused_with_its_problems() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let path = format!("/api/projects/{project}/milestones");
    let missing = api.post(&path, json!({"summary": "x"})).send().await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["data"]["problems"], json!(["missing \"title\""]));
    let wrong = api.post(&path, json!({"title": " ", "priority": "P9", "position": "top", "due": "soon"})).send().await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.body["data"]["problems"].as_array().unwrap().len(), 4, "{}", wrong.body);
    assert_eq!(api.get(&path).send().await.body, json!([]));
    milestone(&api, &project, json!({"title": "Sieve"})).await;
    assert_eq!(api.patch(&format!("{path}/1"), json!({"title": null})).send().await.status, 400);
}

#[tokio::test]
async fn milestones_of_a_missing_project_or_a_missing_milestone_are_not_found() {
    let api = TestApi::new().await;
    assert_eq!(api.get("/api/projects/nope/milestones").send().await.status, 404);
    assert_eq!(api.post("/api/projects/nope/milestones", json!({"title": "Sieve"})).send().await.status, 404);
    let project = api.project("Primes").await;
    let path = format!("/api/projects/{project}/milestones/7");
    assert_eq!(api.get(&path).send().await.status, 404);
    assert_eq!(api.patch(&path, json!({"title": "x"})).send().await.status, 404);
    assert_eq!(api.delete(&path).send().await.status, 404);
}

#[tokio::test]
async fn deleting_a_milestone_leaves_its_issues_in_none() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    milestone(&api, &project, json!({"title": "Sieve"})).await;
    let issue = api.issue(&project, json!({"title": "Sieve", "milestone": "1"})).await;
    let gone = api.delete(&format!("/api/projects/{project}/milestones/1")).send().await;
    assert_eq!(gone.status, 204, "{}", gone.body);
    assert_eq!(told(&gone), [format!("issue.milestone {project} {issue} 1 ~")]);
    assert_eq!(gone.header("orrery-changed"), Some(project.as_str()));
    let row = sqlx::query("SELECT payload FROM changes WHERE kind = 'issue.milestone'").fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(row.get::<Option<String>, _>("payload").as_deref(), Some(r#"{"from":"1"}"#));
    assert_eq!(api.get(&format!("/api/projects/{project}/milestones")).send().await.body, json!([]));
    let read = api.get(&format!("/api/projects/{project}/issues/{issue}")).send().await;
    assert_eq!(read.status, 200);
    assert!(read.body.get("milestone").is_none_or(Value::is_null), "{}", read.body);
    // Its number isn't given out again.
    assert_eq!(milestone(&api, &project, json!({"title": "Next"})).await["id"], "2");
}

#[tokio::test]
async fn an_agent_deletes_its_own_milestones_but_not_the_owner_s() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    milestone(&api, &project, json!({"title": "Owned"})).await;
    let path = format!("/api/projects/{project}/milestones");
    let refused = api.delete(&format!("{path}/1")).by_agent("claude").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(refused.body["data"]["permission"], "issues.delete");
    let theirs = api.post(&path, json!({"title": "Theirs"})).by_agent("claude").send().await;
    assert_eq!(theirs.status, 201);
    assert_eq!(theirs.body["protected"], false);
    assert_eq!(theirs.body["created_by"], "claude");
    assert_eq!(api.patch(&format!("{path}/1"), json!({"summary": "x"})).by_agent("claude").send().await.status, 200, "changing one is anyone's");
    assert_eq!(api.delete(&format!("{path}/2")).by_agent("claude").send().await.status, 204);
    assert_eq!(api.get(&format!("{path}/1")).send().await.status, 200);
}
