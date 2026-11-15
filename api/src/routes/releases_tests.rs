// The tests of routes/releases.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};

/// A project with releases of its own, or taking them from `from`: its id.
async fn shipping(api: &TestApi, name: &str, from: Option<&str>) -> String {
    let body = match from {
        Some(from) => json!({"name": name, "releases_from": from}),
        None => json!({"name": name, "release_mode": "own"}),
    };
    let reply = api.post("/api/projects", body).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    reply.body["id"].as_str().unwrap().to_string()
}

async fn release(api: &TestApi, project: &str, body: Value) -> Value {
    let reply = api.post(&format!("/api/projects/{project}/releases"), body).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    reply.body
}

fn versions(list: &Value) -> Vec<&str> {
    list.as_array().unwrap().iter().map(|r| r["version"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn a_project_without_releases_has_none_and_makes_none() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let listed = api.get(&format!("/api/projects/{project}/releases")).send().await;
    assert_eq!(listed.status, 200);
    assert_eq!(listed.body, json!([]));
    let refused = api.post(&format!("/api/projects/{project}/releases"), json!({"version": "1.0"})).send().await;
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert!(refused.body["message"].as_str().unwrap().contains("has no releases"), "{}", refused.body);
}

#[tokio::test]
async fn a_new_release_goes_on_top_and_is_told() {
    let api = TestApi::new().await;
    let project = shipping(&api, "Primes", None).await;
    let reply = api.post(&format!("/api/projects/{project}/releases"), json!({"version": "1.0.0", "branch": "  rc  ", "notes": "First."})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["version"], "1.0.0");
    assert_eq!(reply.body["branch"], "rc", "a branch is kept trimmed");
    assert_eq!(reply.body["notes"], "First.");
    assert_eq!(reply.body["issues"], 0);
    assert_eq!(reply.body["project"], json!(project));
    assert_eq!(reply.body["tasks"], json!([]));
    assert_eq!(reply.body["protected"], true);
    assert!(reply.body.get("doc_mark").is_none(), "only shipping marks the docs");
    assert_eq!(reply.header("orrery-changed"), Some(project.as_str()));
    assert_eq!(reply.told(), [format!("release.created {project} 1.0.0")]);
    release(&api, &project, json!({"version": "1.1.0"})).await;
    release(&api, &project, json!({"version": "0.9.0", "position": 99})).await;
    let listed = api.get(&format!("/api/projects/{project}/releases")).send().await.body;
    assert_eq!(versions(&listed), ["1.1.0", "1.0.0", "0.9.0"], "new on top; position puts one where it says");
    assert_eq!(api.get(&format!("/api/projects/{project}/releases/1.0.0")).send().await.body, reply.body);
}

#[tokio::test]
async fn a_bad_or_taken_release_is_refused() {
    let api = TestApi::new().await;
    let project = shipping(&api, "Primes", None).await;
    let path = format!("/api/projects/{project}/releases");
    let missing = api.post(&path, json!({})).send().await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["data"]["problems"], json!(["missing \"version\""]));
    let wrong = api.post(&path, json!({"version": "1 0", "shipped_on": "today", "codename": "x", "position": null})).send().await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.body["data"]["problems"].as_array().unwrap().len(), 4, "{}", wrong.body);
    release(&api, &project, json!({"version": "1.0"})).await;
    assert_eq!(api.post(&path, json!({"version": "1.0"})).send().await.status, 409);
    assert_eq!(versions(&api.get(&path).send().await.body), ["1.0"]);
}

#[tokio::test]
async fn releases_of_a_missing_project_or_a_missing_release_are_not_found() {
    let api = TestApi::new().await;
    assert_eq!(api.get("/api/projects/nope/releases").send().await.status, 404);
    assert_eq!(api.post("/api/projects/nope/releases", json!({"version": "1.0"})).send().await.status, 404);
    let project = shipping(&api, "Primes", None).await;
    let path = format!("/api/projects/{project}/releases/2.0");
    assert_eq!(api.get(&path).send().await.status, 404);
    assert_eq!(api.patch(&path, json!({"notes": "x"})).send().await.status, 404);
    assert_eq!(api.delete(&path).send().await.status, 404);
}

#[tokio::test]
async fn freezing_and_shipping_a_release_are_told_and_shipping_marks_the_docs() {
    let api = TestApi::new().await;
    let project = shipping(&api, "Primes", None).await;
    release(&api, &project, json!({"version": "1.0"})).await;
    api.post(&format!("/api/projects/{project}/docs"), json!({"title": "Plan"})).send().await;
    let path = format!("/api/projects/{project}/releases/1.0");

    let frozen = api.patch(&path, json!({"frozen_on": "2026-11-01"})).send().await;
    assert_eq!(frozen.status, 200, "{}", frozen.body);
    assert_eq!(frozen.body["frozen_on"], "2026-11-01");
    assert_eq!(frozen.told(), [format!("release.frozen {project} 1.0")]);
    let again = api.patch(&path, json!({"frozen_on": "2026-11-02"})).send().await;
    assert_eq!(again.header("orrery-told"), None, "a new day on one already frozen is no event");
    assert_eq!(again.header("orrery-changed"), Some(project.as_str()));

    let shipped = api.patch(&path, json!({"shipped_on": "2026-11-05"})).send().await;
    assert_eq!(shipped.told(), [format!("release.shipped {project} 1.0")]);
    assert!(shipped.body["doc_mark"].as_i64().is_some_and(|m| m > 0), "{}", shipped.body);

    let back = api.patch(&path, json!({"shipped_on": null, "frozen_on": null})).send().await;
    assert_eq!(back.status, 200);
    assert_eq!(back.told(), [format!("release.thawed {project} 1.0"), format!("release.unshipped {project} 1.0")]);
    assert!(back.body.get("doc_mark").is_none(), "un-shipping lets go of the mark: {}", back.body);
    assert!(back.body.get("shipped_on").is_none());
}

#[tokio::test]
async fn a_release_keeps_its_version_and_moves_where_position_says() {
    let api = TestApi::new().await;
    let project = shipping(&api, "Primes", None).await;
    for version in ["1.0", "1.1", "1.2"] {
        release(&api, &project, json!({"version": version})).await;
    }
    let path = format!("/api/projects/{project}/releases");
    let renamed = api.patch(&format!("{path}/1.0"), json!({"version": "2.0"})).send().await;
    assert_eq!(renamed.status, 400, "{}", renamed.body);
    assert_eq!(api.patch(&format!("{path}/1.0"), json!({"version": "1.0", "notes": "same"})).send().await.status, 200);
    let moved = api.patch(&format!("{path}/1.0"), json!({"position": 0, "branch": "   "})).send().await;
    assert_eq!(moved.status, 200);
    assert!(moved.body.get("branch").is_none(), "a blank branch is none: {}", moved.body);
    assert_eq!(versions(&api.get(&path).send().await.body), ["1.0", "1.2", "1.1"]);
    assert_eq!(api.patch(&format!("{path}/1.0"), json!({"shipped_on": "soon"})).send().await.status, 400);
}

#[tokio::test]
async fn deleting_a_release_leaves_its_issues_set_for_none() {
    let api = TestApi::new().await;
    let project = shipping(&api, "Primes", None).await;
    release(&api, &project, json!({"version": "1.0"})).await;
    let issue = api.issue(&project, json!({"title": "Sieve", "release": "1.0"})).await;
    let listed = api.get(&format!("/api/projects/{project}/releases")).send().await.body;
    assert_eq!(listed[0]["issues"], 1, "{listed}");
    let one = api.get(&format!("/api/projects/{project}/releases/1.0")).send().await.body;
    assert_eq!(one["tasks"][0]["id"], json!(issue), "{one}");

    let gone = api.delete(&format!("/api/projects/{project}/releases/1.0")).send().await;
    assert_eq!(gone.status, 204, "{}", gone.body);
    assert_eq!(gone.told(), [format!("release.deleted {project} 1.0")]);
    assert_eq!(api.get(&format!("/api/projects/{project}/releases")).send().await.body, json!([]));
    let read = api.get(&format!("/api/projects/{project}/issues/{issue}")).send().await.body;
    assert!(read.get("release").is_none_or(Value::is_null), "{read}");
}

#[tokio::test]
async fn an_agent_deletes_its_own_releases_but_not_the_owner_s() {
    let api = TestApi::new().await;
    let project = shipping(&api, "Primes", None).await;
    release(&api, &project, json!({"version": "1.0"})).await;
    let path = format!("/api/projects/{project}/releases");
    let refused = api.delete(&format!("{path}/1.0")).by_agent("claude").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(refused.body["data"]["permission"], "issues.delete");
    let theirs = api.post(&path, json!({"version": "1.1"})).by_agent("claude").send().await;
    assert_eq!(theirs.status, 201);
    assert_eq!(theirs.body["protected"], false);
    assert_eq!(api.delete(&format!("{path}/1.1")).by_agent("claude").send().await.status, 204);
    assert_eq!(versions(&api.get(&path).send().await.body), ["1.0"]);
}

#[tokio::test]
async fn a_project_sharing_releases_reads_its_source_s_and_changes_none() {
    let api = TestApi::new().await;
    let source = shipping(&api, "Primes", None).await;
    let drawing = shipping(&api, "Gears", Some(&source)).await;
    release(&api, &source, json!({"version": "1.0"})).await;
    let issue = api.issue(&drawing, json!({"title": "Teeth", "release": "1.0"})).await;

    let theirs = api.get(&format!("/api/projects/{drawing}/releases")).send().await;
    assert_eq!(versions(&theirs.body), ["1.0"]);
    let refused = api.post(&format!("/api/projects/{drawing}/releases"), json!({"version": "2.0"})).send().await;
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert!(refused.body["message"].as_str().unwrap().contains(&format!("takes its releases from {source}")), "{}", refused.body);
    assert_eq!(api.patch(&format!("/api/projects/{drawing}/releases/1.0"), json!({"notes": "x"})).send().await.status, 400);
    assert_eq!(api.delete(&format!("/api/projects/{drawing}/releases/1.0")).send().await.status, 400);

    // The source counts every project drawing on it, and its release has each one's part.
    let one = api.get(&format!("/api/projects/{source}/releases/1.0")).send().await.body;
    assert_eq!(one["issues"], 1, "{one}");
    let parts: Vec<&str> = one["projects"].as_array().unwrap().iter().map(|p| p["project"].as_str().unwrap()).collect();
    assert_eq!(parts, [source.as_str(), drawing.as_str()]);
    assert_eq!(one["projects"][0]["issues"], 0);
    assert_eq!(one["projects"][1]["tasks"][0]["id"], json!(issue));

    // Deleting it lets go of it in every project drawing on it too.
    assert_eq!(api.delete(&format!("/api/projects/{source}/releases/1.0")).send().await.status, 204);
    let read = api.get(&format!("/api/projects/{drawing}/issues/{issue}")).send().await.body;
    assert!(read.get("release").is_none_or(Value::is_null), "{read}");
}

#[tokio::test]
async fn every_release_is_listed_once_with_each_project_s_part() {
    let api = TestApi::new().await;
    let source = shipping(&api, "Primes", None).await;
    let drawing = shipping(&api, "Gears", Some(&source)).await;
    api.project("Quiet").await;
    release(&api, &source, json!({"version": "1.0", "notes": "Long notes."})).await;
    api.issue(&drawing, json!({"title": "Teeth", "release": "1.0"})).await;
    api.issue(&source, json!({"title": "Sieve", "release": "1.0"})).await;
    let all = api.get("/api/releases").send().await;
    assert_eq!(all.status, 200);
    let list = all.body.as_array().unwrap();
    assert_eq!(list.len(), 1, "only projects with releases of their own: {}", all.body);
    assert_eq!(list[0]["project"], json!(source));
    assert_eq!(list[0]["projects"], json!([source, drawing]));
    let one = &list[0]["releases"][0];
    assert_eq!(one["version"], "1.0");
    assert_eq!(one["issues"], 2);
    assert!(one.get("notes").is_none(), "listed across projects without notes: {one}");
    assert_eq!(
        one["projects"],
        json!([{"project": source, "issues": 1, "kinds": one["projects"][0]["kinds"]}, {"project": drawing, "issues": 1, "kinds": one["projects"][1]["kinds"]}])
    );
}

#[tokio::test]
async fn a_release_made_shipped_marks_the_docs_as_they_are() {
    let api = TestApi::new().await;
    let project = shipping(&api, "Primes", None).await;
    let before = release(&api, &project, json!({"version": "0.1", "shipped_on": "2026-01-01"})).await;
    assert_eq!(before["doc_mark"], 0, "no doc revision yet: {before}");
    api.post(&format!("/api/projects/{project}/docs"), json!({"title": "Plan"})).send().await;
    let after = release(&api, &project, json!({"version": "0.2", "shipped_on": "2026-02-01", "frozen_on": "2026-01-20"})).await;
    assert!(after["doc_mark"].as_i64().is_some_and(|m| m > 0), "{after}");
    assert_eq!(after["frozen_on"], "2026-01-20");
    assert_eq!(
        api.post(&format!("/api/projects/{project}/releases"), json!({"version": "0.3", "shipped_on": "2026-03-01"})).send().await.told(),
        [format!("release.created {project} 0.3")],
        "made shipped is made, not shipped"
    );
}

/// What counts the boards up from their outlines (ORR-1117), a project's counts in the list and the releases' tallies,
/// comes out as from the whole board, the order of the counts too: sub-issues with releases of their own or their
/// parent's, proposals and what's under them, and a project drawing on another's releases.
#[tokio::test]
async fn counting_from_the_outline_matches_the_whole_board() {
    let api = TestApi::new().await;
    let source = shipping(&api, "Source", None).await;
    let drawing = shipping(&api, "Drawing", Some(&source)).await;
    for version in ["1.0", "2.0"] {
        release(&api, &source, json!({"version": version})).await;
    }
    let issues = format!("/api/projects/{source}/issues");
    let made = |reply: crate::testing::Reply| reply.body["id"].as_str().unwrap().to_string();
    let milestone = api.post(&format!("/api/projects/{source}/milestones"), json!({"title": "First"})).send().await.body["id"].as_str().unwrap().to_string();
    let top = api.issue(&source, json!({"title": "Top", "milestone": milestone, "release": "1.0"})).await;
    api.issue(&source, json!({"title": "Sub", "parent": top, "status": "in-progress"})).await;
    let own = api.issue(&source, json!({"title": "Own", "parent": top, "release": "2.0", "status": "done"})).await;
    api.issue(&source, json!({"title": "Deep", "parent": own, "status": "canceled"})).await;
    api.issue(&source, json!({"title": "Loose", "release": "2.0"})).await;
    let idea = made(api.post(&issues, json!({"title": "Idea", "proposal": "pending"})).by_agent("claude").send().await);
    api.post(&issues, json!({"title": "Part", "parent": idea, "release": "1.0"})).by_agent("claude").send().await;
    api.issue(&drawing, json!({"title": "Theirs", "release": "1.0", "status": "todo"})).await;

    let listed = api.get("/api/projects").send().await.body;
    for project in [&source, &drawing] {
        let whole = api.get(&format!("/api/projects/{project}")).send().await.body;
        let counted = listed.as_array().unwrap().iter().find(|p| p["id"] == *project).unwrap();
        assert_eq!(counted["counts"].to_string(), whole["board"]["counts"].to_string(), "{project}");
        assert_eq!(counted["kinds"].to_string(), whole["board"]["kinds"].to_string(), "{project}");
        assert_eq!(counted["releases"], whole["releases"], "{project}");
        assert_eq!(api.get(&format!("/api/projects/{project}/releases")).send().await.body, whole["releases"], "{project}");
    }
    let whole = api.get(&format!("/api/projects/{source}")).send().await.body;
    assert!(whole["releases"][0]["kinds"].as_object().unwrap().values().map(|n| n.as_i64().unwrap()).sum::<i64>() > 0);
    let all = api.get("/api/releases").send().await.body;
    let one = all[0]["releases"].as_array().unwrap().iter().find(|r| r["version"] == "1.0").unwrap();
    let from_whole = whole["releases"].as_array().unwrap().iter().find(|r| r["version"] == "1.0").unwrap();
    assert_eq!((&one["issues"], &one["kinds"]), (&from_whole["issues"], &from_whole["kinds"]));
}

/// A release's row as it's stored, in the project's source, for the local app's store (`releaseRow`, ORR-1174): a 400
/// with no releases, a 404 for one there isn't, saying where it looked, and only the local app asks.
#[tokio::test]
async fn the_local_app_reads_a_releases_row_in_its_source() {
    let api = TestApi::new().await;
    let source = shipping(&api, "Primes", None).await;
    let drawing = shipping(&api, "Sieve", Some(&source)).await;
    release(&api, &source, json!({"version": "1.0.0"})).await;
    for project in [&source, &drawing] {
        let row = api.get(&format!("/api/projects/{project}/releases/1.0.0/row")).send().await;
        assert_eq!(row.status, 200, "{}", row.body);
        assert_eq!((row.body["project"].as_str(), row.body["version"].as_str()), (Some(source.as_str()), Some("1.0.0")));
    }
    let gone = api.get(&format!("/api/projects/{drawing}/releases/9.9.9/row")).send().await;
    assert_eq!(gone.status, 404);
    assert!(gone.body["message"].as_str().unwrap().contains(&format!("(where {drawing} takes its releases from)")), "{}", gone.body);
    let none = api.project("Plain").await;
    assert_eq!(api.get(&format!("/api/projects/{none}/releases/1.0.0/row")).send().await.status, 400);
    assert_eq!(api.get("/api/projects/nowhere/releases/1.0.0/row").send().await.status, 404);
    let door = TestApi::at_the_door().await;
    let theirs = shipping(&door, "Primes", None).await;
    assert_eq!(door.get(&format!("/api/projects/{theirs}/releases/1.0.0/row")).send().await.status, 403);
}
