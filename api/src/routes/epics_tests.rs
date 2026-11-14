// The tests of routes/epics.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};
use sqlx::Row;

async fn epic(api: &TestApi, body: Value) -> Value {
    let reply = api.post("/api/epics", body).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    reply.body
}

fn ids(list: &Value) -> Vec<i64> {
    list.as_array().unwrap().iter().map(|e| e["id"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn a_new_epic_goes_on_top_and_says_the_epics_changed() {
    let api = TestApi::new().await;
    let before: i64 = sqlx::query("SELECT count(*) AS n FROM changes").fetch_one(&api.app.pool).await.unwrap().get("n");
    let reply = api.post("/api/epics", json!({"title": " Gears ", "notes": "Every wheel."})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["id"], 1);
    assert_eq!(reply.body["title"], "Gears");
    assert_eq!(reply.body["notes"], "Every wheel.");
    assert_eq!(reply.body["issues"], 0);
    assert_eq!(reply.body["projects"], json!([]));
    assert_eq!(reply.body["parts"], json!([]));
    assert_eq!(reply.body["protected"], true);
    assert!(reply.body["full_id"].as_str().unwrap().starts_with("EPC-1-"), "{}", reply.body);
    assert_eq!(reply.header("orrery-epics"), Some("1"));
    assert_eq!(reply.header("orrery-changed"), None, "no board changed");
    let kinds: Vec<String> =
        sqlx::query("SELECT kind FROM changes ORDER BY id").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("kind")).collect();
    assert_eq!(kinds[before as usize..], ["epics".to_string()]);

    epic(&api, json!({"title": "Wheels"})).await;
    epic(&api, json!({"title": "Axles", "position": 99})).await;
    let listed = api.get("/api/epics").send().await;
    assert_eq!(listed.status, 200);
    assert_eq!(ids(&listed.body), [2, 1, 3], "new on top, unless position says where");
}

#[tokio::test]
async fn an_epic_is_read_by_its_number_or_its_id() {
    let api = TestApi::new().await;
    let made = epic(&api, json!({"title": "Gears"})).await;
    let full = made["full_id"].as_str().unwrap().to_string();
    for sent in ["1", "EPC-1", full.as_str()] {
        let read = api.get(&format!("/api/epics/{sent}")).send().await;
        assert_eq!(read.status, 200, "{sent}: {}", read.body);
        assert_eq!(read.body["id"], 1);
    }
    for sent in ["2", "gears", "EPC-x"] {
        assert_eq!(api.get(&format!("/api/epics/{sent}")).send().await.status, 404, "{sent}");
    }
    assert_eq!(api.patch("/api/epics/2", json!({"title": "x"})).send().await.status, 404);
    assert_eq!(api.delete("/api/epics/2").send().await.status, 404);
}

#[tokio::test]
async fn an_epic_counts_its_issues_in_each_project() {
    let api = TestApi::new().await;
    let (a, b) = (api.project("Primes").await, api.project("Gears").await);
    epic(&api, json!({"title": "Wheels"})).await;
    let one = api.issue(&a, json!({"title": "Sieve", "epic": 1})).await;
    let two = api.issue(&b, json!({"title": "Teeth", "epic": "EPC-1"})).await;
    api.issue(&b, json!({"title": "Elsewhere"})).await;
    let listed = api.get("/api/epics").send().await.body;
    assert_eq!(listed[0]["issues"], 2, "{listed}");
    let parts: Vec<(&str, i64)> =
        listed[0]["projects"].as_array().unwrap().iter().map(|p| (p["project"].as_str().unwrap(), p["issues"].as_i64().unwrap())).collect();
    let mut expected = vec![(a.as_str(), 1), (b.as_str(), 1)];
    expected.sort();
    assert_eq!(parts, expected);
    let read = api.get("/api/epics/1").send().await.body;
    let tasks: Vec<&Value> = read["parts"].as_array().unwrap().iter().map(|p| &p["tasks"][0]["id"]).collect();
    assert!(tasks.contains(&&json!(one)) && tasks.contains(&&json!(two)), "{read}");
    assert_eq!(read["parts"].as_array().unwrap().iter().map(|p| p["tasks"].as_array().unwrap().len()).sum::<usize>(), 2);
    assert!(read["parts"][0]["name"].is_string(), "{read}");
}

#[tokio::test]
async fn rewording_an_epic_tells_each_project_in_it_and_moving_it_tells_none() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    epic(&api, json!({"title": "Wheels", "notes": "Round."})).await;
    api.issue(&project, json!({"title": "Sieve", "epic": 1})).await;
    let reworded = api.patch("/api/epics/1", json!({"title": "Big wheels", "notes": null})).send().await;
    assert_eq!(reworded.status, 200, "{}", reworded.body);
    assert_eq!(reworded.body["title"], "Big wheels");
    assert!(reworded.body.get("notes").is_none(), "{}", reworded.body);
    assert_eq!(reworded.told(), [format!("epic.changed {project} 1")]);
    assert_eq!(reworded.header("orrery-epics"), Some("1"));
    let same = api.patch("/api/epics/1", json!({"title": "Big wheels"})).send().await;
    assert_eq!(same.header("orrery-told"), None, "the same words are no change");
    epic(&api, json!({"title": "Axles"})).await;
    let moved = api.patch("/api/epics/1", json!({"position": 0})).send().await;
    assert_eq!(moved.status, 200);
    assert_eq!(moved.header("orrery-told"), None);
    assert_eq!(moved.header("orrery-epics"), Some("1"));
    assert_eq!(ids(&api.get("/api/epics").send().await.body), [1, 2]);
}

#[tokio::test]
async fn a_bad_epic_is_refused_with_its_problems() {
    let api = TestApi::new().await;
    let missing = api.post("/api/epics", json!({"notes": "x"})).send().await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["data"]["problems"], json!(["missing \"title\""]));
    let wrong = api.post("/api/epics", json!({"title": " ", "notes": 1, "position": "top", "owner": "me"})).send().await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.body["data"]["problems"].as_array().unwrap().len(), 4, "{}", wrong.body);
    assert_eq!(api.get("/api/epics").send().await.body, json!([]));
    epic(&api, json!({"title": "Gears"})).await;
    assert_eq!(api.patch("/api/epics/1", json!({"title": null})).send().await.status, 400);
}

#[tokio::test]
async fn deleting_an_epic_leaves_its_issues_in_none() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    epic(&api, json!({"title": "Wheels"})).await;
    let issue = api.issue(&project, json!({"title": "Sieve", "epic": 1})).await;
    let gone = api.delete("/api/epics/1").send().await;
    assert_eq!(gone.status, 204, "{}", gone.body);
    assert_eq!(gone.told(), [format!("issue.epic {project} {issue} 1 ~")]);
    assert_eq!(gone.header("orrery-changed"), Some(project.as_str()));
    assert_eq!(gone.header("orrery-epics"), Some("1"));
    assert_eq!(api.get("/api/epics").send().await.body, json!([]));
    let read = api.get(&format!("/api/projects/{project}/issues/{issue}")).send().await;
    assert_eq!(read.status, 200);
    assert!(read.body.get("epic").is_none_or(Value::is_null), "{}", read.body);
}

#[tokio::test]
async fn an_agent_deletes_its_own_epics_but_not_the_owner_s() {
    let api = TestApi::new().await;
    epic(&api, json!({"title": "Owned"})).await;
    let refused = api.delete("/api/epics/1").by_agent("claude").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(refused.body["data"]["permission"], "epics.delete");
    let theirs = api.post("/api/epics", json!({"title": "Theirs"})).by_agent("claude").send().await;
    assert_eq!(theirs.status, 201);
    assert_eq!(theirs.body["protected"], false);
    assert_eq!(theirs.body["created_by"], "claude");
    assert_eq!(api.patch("/api/epics/1", json!({"notes": "x"})).by_agent("claude").send().await.status, 200, "changing one is anyone's");
    assert_eq!(api.delete("/api/epics/2").by_agent("claude").send().await.status, 204);
    assert_eq!(ids(&api.get("/api/epics").send().await.body), [1]);
}

#[tokio::test]
async fn deleting_an_epic_says_each_project_in_it_changed() {
    let api = TestApi::new().await;
    let (a, b) = (api.project("Primes").await, api.project("Gears").await);
    api.project("Quiet").await;
    epic(&api, json!({"title": "Wheels"})).await;
    api.issue(&a, json!({"title": "Sieve", "epic": 1})).await;
    api.issue(&b, json!({"title": "Teeth", "epic": 1})).await;
    let gone = api.delete("/api/epics/1").send().await;
    assert_eq!(gone.status, 204);
    let mut changed: Vec<&str> = gone.header("orrery-changed").unwrap().split(", ").collect();
    changed.sort();
    let mut expected = vec![a.as_str(), b.as_str()];
    expected.sort();
    assert_eq!(changed, expected);
    assert_eq!(gone.told().len(), 2);
}

/// An epic is its workspace's (ORR-1107): made in the one `Orrery-Workspace` names, listed and read only there, and a
/// 404 to someone who isn't in it, or asking from another.
#[tokio::test]
async fn an_epic_is_its_workspaces_alone() {
    let api = TestApi::new().await;
    api.team().await;
    api.acme(&["bo"]).await;
    let as_bo = |req: crate::testing::Req| {
        let api = &api;
        async move { api.signed(req.header("orrery-sent-origin", "http://localhost"), "bo").await.send().await }
    };
    let made = as_bo(api.post("/api/epics", json!({"title": "Launch"})).header("orrery-workspace", "acme")).await;
    assert_eq!(made.status, 201, "{}", made.body);
    let id = made.body["id"].as_i64().unwrap();
    let workspace: String = sqlx::query("SELECT workspace FROM epics WHERE id = $1").bind(id).fetch_one(&api.app.pool).await.unwrap().get("workspace");
    assert_eq!(workspace, "acme");
    let theirs = as_bo(api.post("/api/epics", json!({"title": "Tidy"}))).await;
    assert_eq!(theirs.status, 201, "with none named, it's default's: {}", theirs.body);

    assert_eq!(ids(&as_bo(api.get("/api/epics").header("orrery-workspace", "acme")).await.body), vec![id]);
    assert_eq!(ids(&as_bo(api.get("/api/epics")).await.body), vec![theirs.body["id"].as_i64().unwrap()]);
    assert_eq!(as_bo(api.get(&format!("/api/epics/{id}")).header("orrery-workspace", "acme")).await.status, 200);
    assert_eq!(as_bo(api.get(&format!("/api/epics/{id}"))).await.status, 404, "asked from default, Acme's epic isn't there");

    let ana = api.signed(api.get("/api/epics").header("orrery-workspace", "acme"), "ana").await.send().await;
    assert_eq!(ana.status, 404, "ana isn't in Acme: {}", ana.body);
    let ana = api.signed(api.get(&format!("/api/epics/{id}")), "ana").await.send().await;
    assert_eq!(ana.status, 404, "{}", ana.body);
    let ana = api.signed(api.get(&format!("/api/epics/{id}/comments")), "ana").await.send().await;
    assert_eq!(ana.status, 404, "{}", ana.body);
    let ana = api.signed(api.delete(&format!("/api/epics/{id}")).header("orrery-sent-origin", "http://localhost"), "ana").await.send().await;
    assert_eq!(ana.status, 404, "{}", ana.body);
}
