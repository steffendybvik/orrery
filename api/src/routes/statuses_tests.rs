// The tests of routes/statuses.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{ids, TestApi};
use serde_json::json;

#[tokio::test]
async fn a_new_orrery_has_the_default_statuses_in_board_order() {
    let api = TestApi::new().await;
    let reply = api.get("/api/statuses").send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(ids(&reply.body), ["backlog", "todo", "in-progress", "in-review", "done", "canceled"]);
    assert_eq!(reply.body[2], json!({"id": "in-progress", "name": "In progress", "kind": "started", "color": "amber", "position": 2.0}));
}

#[tokio::test]
async fn a_new_status_goes_last_and_tells_every_board_and_the_settings() {
    let api = TestApi::new().await;
    let (a, b) = (api.project("Primes").await, api.project("Gears").await);
    let before = api.outbox().await.len();
    let reply = api.post("/api/statuses", json!({"name": " QA ", "kind": "started"})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body, json!({"id": "qa", "name": "QA", "kind": "started", "color": "slate", "position": 6.0}));
    let mut both = vec![a, b];
    both.sort();
    assert_eq!(reply.changed(), both);
    assert_eq!(reply.header("orrery-settings"), Some("1"));
    assert_eq!(reply.header("orrery-told"), None);
    let kinds: Vec<String> = api.outbox().await.into_iter().map(|row| row.kind).collect();
    assert_eq!(kinds[before..].iter().filter(|k| *k == "project.changed").count(), 2);
    assert!(kinds[before..].contains(&"settings".to_string()), "{kinds:?}");
    // Listed with the other started ones, not last, as it's in board order.
    assert_eq!(ids(&api.get("/api/statuses").send().await.body), ["backlog", "todo", "in-progress", "in-review", "qa", "done", "canceled"]);
}

#[tokio::test]
async fn a_status_takes_its_own_id_colour_and_position() {
    let api = TestApi::new().await;
    let reply = api.post("/api/statuses", json!({"id": "triage", "name": "Needs a look", "kind": "backlog", "color": "#3b82f6", "position": -1})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["id"], "triage");
    assert_eq!(reply.body["color"], "#3b82f6");
    assert_eq!(ids(&api.get("/api/statuses").send().await.body)[..2], ["triage".to_string(), "backlog".to_string()]);
}

#[tokio::test]
async fn a_bad_status_is_refused_with_its_problems() {
    let api = TestApi::new().await;
    let missing = api.post("/api/statuses", json!({})).send().await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["data"]["problems"], json!(["missing \"name\"", "missing \"kind\""]));
    let wrong = api.post("/api/statuses", json!({"name": "QA", "kind": "doing", "color": "red", "shade": 1})).send().await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.body["data"]["problems"].as_array().unwrap().len(), 3, "{}", wrong.body);
    assert_eq!(api.post("/api/statuses", json!({"name": "Proposed", "kind": "backlog"})).send().await.status, 400, "proposed is taken by proposals");
    assert_eq!(api.post("/api/statuses", json!({"name": "!!!", "kind": "backlog"})).send().await.status, 400, "no id to make");
    assert_eq!(api.post("/api/statuses", json!({"name": "Todo", "kind": "todo"})).send().await.status, 409);
    assert_eq!(ids(&api.get("/api/statuses").send().await.body).len(), 6, "nothing was made");
}

#[tokio::test]
async fn an_agent_cannot_change_the_statuses() {
    let api = TestApi::new().await;
    for reply in [
        api.post("/api/statuses", json!({"name": "QA", "kind": "started"})).by_agent("claude").send().await,
        api.patch("/api/statuses/todo", json!({"name": "To do"})).by_agent("claude").send().await,
        api.delete("/api/statuses/in-review").by_agent("claude").send().await,
    ] {
        assert_eq!(reply.status, 403, "{}", reply.body);
        assert_eq!(reply.body["data"]["permission"], "settings.write");
    }
    assert_eq!(api.get("/api/statuses").by_agent("claude").send().await.status, 200, "reading them is anyone's");
    assert_eq!(ids(&api.get("/api/statuses").send().await.body).len(), 6);
}

#[tokio::test]
async fn a_status_is_renamed_recoloured_and_moved() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/statuses/todo", json!({"name": " To do ", "color": "teal", "kind": "todo"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!({"id": "todo", "name": "To do", "kind": "todo", "color": "teal", "position": 1.0}));
    assert_eq!(reply.header("orrery-settings"), Some("1"));
    let moved = api.patch("/api/statuses/in-review", json!({"kind": "done"})).send().await;
    assert_eq!(moved.status, 200);
    assert_eq!(ids(&api.get("/api/statuses").send().await.body), ["backlog", "todo", "in-progress", "in-review", "done", "canceled"]);
    let placed = api.patch("/api/statuses/in-review", json!({"position": 9})).send().await;
    assert_eq!(placed.body["position"], 9.0, "{}", placed.body);
}

#[tokio::test]
async fn a_status_keeps_its_id_and_its_kind_keeps_one() {
    let api = TestApi::new().await;
    let id = api.patch("/api/statuses/todo", json!({"id": "later"})).send().await;
    assert_eq!(id.status, 400, "{}", id.body);
    let last = api.patch("/api/statuses/backlog", json!({"kind": "todo"})).send().await;
    assert_eq!(last.status, 409, "the only backlog status stays one: {}", last.body);
    assert_eq!(api.patch("/api/statuses/nope", json!({"name": "x"})).send().await.status, 404);
    assert_eq!(api.patch("/api/statuses/todo", json!({"name": ""})).send().await.status, 400);
}

#[tokio::test]
async fn a_status_with_nothing_in_it_is_deleted() {
    let api = TestApi::new().await;
    let reply = api.delete("/api/statuses/in-review").send().await;
    assert_eq!(reply.status, 204, "{}", reply.body);
    assert_eq!(reply.header("orrery-settings"), Some("1"));
    assert!(!ids(&api.get("/api/statuses").send().await.body).contains(&"in-review".to_string()));
    assert_eq!(api.delete("/api/statuses/in-review").send().await.status, 404);
}

#[tokio::test]
async fn the_last_status_of_a_kind_cannot_be_deleted() {
    let api = TestApi::new().await;
    let reply = api.delete("/api/statuses/backlog").send().await;
    assert_eq!(reply.status, 409, "{}", reply.body);
    api.delete("/api/statuses/in-review").send().await;
    assert_eq!(api.delete("/api/statuses/in-progress").send().await.status, 409);
}

#[tokio::test]
async fn a_status_in_use_moves_its_issues_where_into_says() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let issue = api.issue(&project, json!({"title": "Sieve", "status": "in-review"})).await;
    let refused = api.delete("/api/statuses/in-review").send().await;
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert_eq!(api.delete("/api/statuses/in-review?into=in-review").send().await.status, 400);
    assert_eq!(api.delete("/api/statuses/in-review?into=nope").send().await.status, 404);
    let moved = api.delete("/api/statuses/in-review?into=in-progress").send().await;
    assert_eq!(moved.status, 204, "{}", moved.body);
    assert_eq!(moved.header("orrery-changed"), Some(project.as_str()));
    let read = api.get(&format!("/api/projects/{project}/issues/{issue}")).send().await;
    assert_eq!(read.body["status"], "in-progress", "{}", read.body);
}

/// Statuses are their workspace's (ORR-1107): a new workspace starts with its own copy of the set orrery ships, with
/// the same ids (ORR-1442), and an issue there takes its workspace's statuses alone, by id or by kind.
#[tokio::test]
async fn each_workspace_has_its_own_statuses() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = api.acme(&["sam"]).await;
    let acme = api.get("/api/statuses").header("orrery-workspace", "acme").send().await;
    assert_eq!(ids(&acme.body), ["backlog", "todo", "in-progress", "in-review", "done", "canceled"], "{}", acme.body);
    assert_eq!(api.count("SELECT count(*) FROM statuses WHERE workspace = 'acme'").await, 6, "its own rows");

    let made = api.post("/api/statuses", json!({"name": "Testing", "kind": "started"})).header("orrery-workspace", "acme").send().await;
    assert_eq!((made.status.as_u16(), made.body["id"].as_str()), (201, Some("testing")), "{}", made.body);
    assert!(!ids(&api.get("/api/statuses").send().await.body).contains(&"testing".to_string()), "default's list doesn't have it");

    let by_kind = api.post(&format!("/api/projects/{rockets}/issues"), json!({"title": "Fuel", "status": "todo"})).send().await;
    assert_eq!((by_kind.status.as_u16(), by_kind.body["status"].as_str()), (201, Some("todo")), "{}", by_kind.body);
    let ours = api.post("/api/statuses", json!({"name": "QA", "kind": "started"})).send().await;
    assert_eq!(ours.body["id"], "qa", "{}", ours.body);
    let theirs = api.post(&format!("/api/projects/{rockets}/issues"), json!({"title": "Stray", "status": "qa"})).send().await;
    assert_eq!(theirs.status, 400, "default's own status isn't one for Acme's issues: {}", theirs.body);
    let ana = api.signed(api.get("/api/statuses").header("orrery-workspace", "acme"), "ana").await.send().await;
    assert_eq!(ana.status, 404, "{}", ana.body);
}

/// An issue outside `default` moves by the plain id (ORR-1442), and the id its status had before, with the workspace's
/// id in front, still finds it, as stored scripts send it; the issue reads back the plain one.
#[tokio::test]
async fn an_issue_in_another_workspace_moves_by_the_plain_id_or_the_old_one() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = api.acme(&["sam"]).await;
    let issue = api.issue(&rockets, json!({"title": "Fuel"})).await;
    let path = format!("/api/projects/{rockets}/issues/{issue}");
    let moved = api.patch(&path, json!({"status": "in-progress"})).send().await;
    assert_eq!((moved.status.as_u16(), moved.body["status"].as_str()), (200, Some("in-progress")), "{}", moved.body);
    let old = api.patch(&path, json!({"status": "acme-in-review"})).send().await;
    assert_eq!((old.status.as_u16(), old.body["status"].as_str()), (200, Some("in-review")), "{}", old.body);
    let listed = api.get(&format!("/api/projects/{rockets}/issues?status=acme-in-review")).send().await;
    assert_eq!(listed.body.as_array().map(Vec::len), Some(1), "{}", listed.body);
    let elsewhere = api.patch(&path, json!({"status": "other-in-review"})).send().await;
    assert_eq!(elsewhere.status, 400, "only its own workspace's id in front: {}", elsewhere.body);
    // The old id finds the status on its own routes too.
    let renamed = api.patch("/api/statuses/acme-in-review", json!({"name": "Review"})).header("orrery-workspace", "acme").send().await;
    assert_eq!((renamed.status.as_u16(), renamed.body["id"].as_str()), (200, Some("in-review")), "{}", renamed.body);
    assert_eq!(api.get("/api/statuses").send().await.body[3]["name"], "In review", "default's own is untouched");
}

/// The same id in two workspaces is no clash (ORR-1442): each makes `review`, a second in one is a 409, and removing
/// one moves only its own workspace's issues.
#[tokio::test]
async fn a_status_id_another_workspace_has_is_no_clash() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = api.acme(&["sam"]).await;
    let primes = api.project("Primes").await;
    let ours = api.post("/api/statuses", json!({"name": "Review", "kind": "started"})).send().await;
    assert_eq!((ours.status.as_u16(), ours.body["id"].as_str()), (201, Some("review")), "{}", ours.body);
    let theirs = api.post("/api/statuses", json!({"name": "Review", "kind": "started"})).header("orrery-workspace", "acme").send().await;
    assert_eq!((theirs.status.as_u16(), theirs.body["id"].as_str()), (201, Some("review")), "{}", theirs.body);
    let again = api.post("/api/statuses", json!({"name": "Review", "kind": "started"})).header("orrery-workspace", "acme").send().await;
    assert_eq!(again.status, 409, "{}", again.body);

    let mine = api.issue(&primes, json!({"title": "Sieve", "status": "review"})).await;
    let acmes = api.issue(&rockets, json!({"title": "Fuel", "status": "review"})).await;
    let gone = api.delete("/api/statuses/review?into=todo").header("orrery-workspace", "acme").send().await;
    assert_eq!(gone.status, 204, "{}", gone.body);
    assert_eq!(api.get(&format!("/api/projects/{rockets}/issues/{acmes}")).send().await.body["status"], "todo");
    assert_eq!(api.get(&format!("/api/projects/{primes}/issues/{mine}")).send().await.body["status"], "review", "default's stays");
    assert!(ids(&api.get("/api/statuses").send().await.body).contains(&"review".to_string()));
}

/// A workspace whose id starts one of `default`'s gets the same ids as any other (ORR-1442): `in`'s are plain too.
#[tokio::test]
async fn a_workspace_named_like_a_default_status_still_gets_its_own() {
    let api = TestApi::new().await;
    api.owner().await;
    api.run("INSERT INTO workspaces (id, name, created_at) VALUES ('in', 'In', '2026-11-01T00:00:00.000Z')", &[]).await;
    api.run("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES ('in', 'sam', 'owner', '2026-11-01T00:00:00.000Z')", &[]).await;
    let listed = api.get("/api/statuses").header("orrery-workspace", "in").send().await;
    assert_eq!(listed.status, 200, "{}", listed.body);
    assert_eq!(ids(&listed.body), ["backlog", "todo", "in-progress", "in-review", "done", "canceled"], "{}", listed.body);
    assert_eq!(api.count("SELECT count(*) FROM statuses WHERE id = 'in-progress'").await, 2);
}
