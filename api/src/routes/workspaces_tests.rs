// The tests of routes/workspaces.rs (ORR-1108), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{Req, TestApi};
use serde_json::{json, Value};

fn ids(list: &Value) -> Vec<&str> {
    list.as_array().unwrap().iter().map(|w| w["id"].as_str().unwrap()).collect()
}

async fn as_person(api: &TestApi, req: Req, person: &str) -> crate::testing::Reply {
    api.signed(req.header("orrery-sent-origin", "http://localhost"), person).await.send().await
}

/// Each person sees the workspaces they're in, `default` first, with their role there; the owner of the installation
/// isn't let into one they aren't in (decision 6).
#[tokio::test]
async fn each_person_lists_the_workspaces_they_are_in() {
    let api = TestApi::new().await;
    api.team().await;
    api.acme(&["bo"]).await;

    let bo = as_person(&api, api.get("/api/workspaces"), "bo").await;
    assert_eq!(bo.status, 200, "{}", bo.body);
    assert_eq!(ids(&bo.body), vec!["default", "acme"]);
    assert_eq!(bo.body[0]["role"], "member");
    assert_eq!(bo.body[1], json!({"id": "acme", "name": "Acme", "color": null, "role": "member"}));

    let steffen = as_person(&api, api.get("/api/workspaces"), "steffen").await;
    assert_eq!(ids(&steffen.body), vec!["default"], "owning the server gives no way into Acme");
    assert_eq!(steffen.body[0]["role"], "owner");

    let all = api.get("/api/workspaces").send().await;
    assert_eq!(ids(&all.body), vec!["default", "acme"], "the Nuxt server's own work reaches every one");
}

/// Anyone here can make a workspace and owns it; its id comes from its name, and another of the same name gets `-2`.
#[tokio::test]
async fn a_person_makes_a_workspace_and_owns_it() {
    let api = TestApi::new().await;
    api.team().await;

    let made = as_person(&api, api.post("/api/workspaces", json!({"name": " Side Projects ", "color": "teal"})), "ana").await;
    assert_eq!(made.status, 201, "{}", made.body);
    assert_eq!(made.body, json!({"id": "side-projects", "name": "Side Projects", "color": "teal", "role": "owner"}));
    assert_eq!(api.count("SELECT count(*) AS n FROM workspace_members WHERE workspace = 'side-projects' AND person = 'ana' AND role = 'owner'").await, 1);

    let again = as_person(&api, api.post("/api/workspaces", json!({"name": "Side projects"})), "bo").await;
    assert_eq!(again.status, 201, "{}", again.body);
    assert_eq!(again.body["id"], "side-projects-2");

    assert_eq!(ids(&as_person(&api, api.get("/api/workspaces"), "ana").await.body), vec!["default", "side-projects"]);
    assert_eq!(ids(&as_person(&api, api.get("/api/workspaces"), "bo").await.body), vec!["default", "side-projects-2"]);
}

/// A workspace needs a name of 1 to 60 characters, and a colour App settings' tint would take.
#[tokio::test]
async fn a_workspace_needs_a_name_and_a_real_colour() {
    let api = TestApi::new().await;
    api.team().await;
    for body in [json!({}), json!({"name": "  "}), json!({"name": "x".repeat(61)}), json!({"name": "Ok", "color": "plaid"})] {
        let reply = as_person(&api, api.post("/api/workspaces", body.clone()), "ana").await;
        assert_eq!(reply.status, 400, "{body}: {}", reply.body);
    }
    assert_eq!(api.count("SELECT count(*) AS n FROM workspaces").await, 1);
}

/// With login off and nobody named, there's nobody to own a new workspace.
#[tokio::test]
async fn nobody_makes_no_workspace() {
    let api = TestApi::new().await;
    let reply = api.post("/api/workspaces", json!({"name": "Mine"})).send().await;
    assert_eq!(reply.status, 403, "{}", reply.body);
}

/// Only a workspace's owners rename or recolour it; a member is refused, and someone outside gets a 404.
#[tokio::test]
async fn only_its_owners_change_a_workspace() {
    let api = TestApi::new().await;
    api.team().await;
    api.acme(&["bo"]).await;
    api.run("UPDATE workspace_members SET role = 'owner' WHERE workspace = 'acme' AND person = 'bo'", &[]).await;
    api.run("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES ('acme', 'ana', 'member', '2026-01-01T00:00:00.000Z')", &[]).await;

    let changed = as_person(&api, api.patch("/api/workspaces/acme", json!({"name": "Acme Inc", "color": "#3b82f6"})), "bo").await;
    assert_eq!(changed.status, 200, "{}", changed.body);
    assert_eq!(changed.body, json!({"id": "acme", "name": "Acme Inc", "color": "#3b82f6", "role": "owner"}));

    let cleared = as_person(&api, api.patch("/api/workspaces/acme", json!({"color": null})), "bo").await;
    assert_eq!(cleared.body["color"], Value::Null);
    assert_eq!(cleared.body["name"], "Acme Inc", "what isn't sent stays");

    let ana = as_person(&api, api.patch("/api/workspaces/acme", json!({"name": "Mine"})), "ana").await;
    assert_eq!(ana.status, 403, "a member: {}", ana.body);
    let steffen = as_person(&api, api.patch("/api/workspaces/acme", json!({"name": "Mine"})), "steffen").await;
    assert_eq!(steffen.status, 404, "not in it: {}", steffen.body);
    let none = as_person(&api, api.patch("/api/workspaces/nowhere", json!({"name": "Mine"})), "bo").await;
    assert_eq!(none.status, 404, "{}", none.body);
}
