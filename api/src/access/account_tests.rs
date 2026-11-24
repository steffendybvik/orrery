// The tests of access/account.rs (ORR-1203): `GET /api/me` and `DELETE /api/me`, through `router()` on a database of
// their own (`crate::testing`), signed in as a browser is.
use crate::testing::{ids, Req, TestApi};
use serde_json::json;

/// As `person` asks from their browser, signed in: their own name on the request, not the owner's.
async fn as_person(api: &TestApi, req: Req, person: &str) -> Req {
    api.signed(req.by_agent(person), person).await
}

/// A workspace `id` owned by `owner`, with `members` in it and a project made in it: the project's id.
async fn workspace(api: &TestApi, id: &str, owner: &str, members: &[&str], project: &str) -> String {
    api.run("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-11-01T00:00:00.000Z')", &[id, id]).await;
    api.run("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES (?, ?, 'owner', '2026-11-01T00:00:00.000Z')", &[id, owner]).await;
    for member in members {
        api.run("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES (?, ?, 'member', '2026-11-01T00:00:00.000Z')", &[id, member]).await;
    }
    let project = api.project(project).await;
    api.run("UPDATE projects SET workspace = ? WHERE id = ?", &[id, &project]).await;
    project
}

#[tokio::test]
async fn shows_the_signed_in_person_their_account() {
    let api = TestApi::new().await;
    api.team().await;
    workspace(&api, "ana-side", "ana", &["bo"], "Side").await;
    api.run("INSERT INTO identities (issuer, subject, person) VALUES ('https://id.example', '42', 'ana')", &[]).await;
    let me = as_person(&api, api.get("/api/me"), "ana").await.send().await;
    assert_eq!(me.status, 200, "{}", me.body);
    assert_eq!((me.body["id"].as_str(), me.body["name"].as_str(), me.body["role"].as_str()), (Some("ana"), Some("ana"), Some("member")));
    assert!(me.body["created_at"].is_string());
    assert_eq!(me.body["identities"], json!([{"issuer": "https://id.example"}]));
    assert_eq!(ids(&me.body["workspaces"]), ["default", "ana-side"]);
    assert_eq!(me.body["workspaces"][0]["role"], "member");
    assert_eq!(me.body["workspaces"][1]["role"], "owner");
    // Nobody signed in, or an agent key, has no account to show.
    assert_eq!(api.get("/api/me").send().await.status, 401);
    let key = api.key("ana", "agent").await;
    let agent = api.get("/api/me").header("orrery-came", "loopback").header("orrery-login-ways", "on").header("orrery-key", &key).send().await;
    assert_eq!(agent.status, 403, "{}", agent.body);
}

#[tokio::test]
async fn refuses_a_delete_without_the_name_typed() {
    let api = TestApi::new().await;
    api.team().await;
    for body in [json!({}), json!({"confirm": "bo"}), json!({"confirm": ""})] {
        let refused = as_person(&api, api.request(axum::http::Method::DELETE, "/api/me").json(body), "ana").await.send().await;
        assert_eq!(refused.status, 400, "{}", refused.body);
    }
    assert_eq!(api.count("SELECT count(*) AS n FROM people WHERE removed_at IS NOT NULL").await, 0);
    assert_eq!(api.count("SELECT count(*) AS n FROM logins WHERE person = 'ana'").await, 3);
}

#[tokio::test]
async fn deletes_the_workspaces_they_own_shared_ones_too_with_their_projects() {
    let api = TestApi::new().await;
    api.team().await;
    let side = workspace(&api, "ana-side", "ana", &["bo"], "Side").await;
    api.issue(&side, json!({"title": "Plan"})).await;
    api.run("INSERT INTO epics (title, created_by, created_at, updated_at, workspace) VALUES ('Big', 'ana', 'x', 'x', 'ana-side')", &[]).await;
    api.run("INSERT INTO workspace_settings (workspace, key, value) VALUES ('ana-side', 'tint', '\"teal\"')", &[]).await;
    api.run("INSERT INTO identities (issuer, subject, person) VALUES ('https://id.example', '42', 'ana')", &[]).await;
    let key = api.key("bo", "agent").await;
    api.run("UPDATE keys SET workspace = 'ana-side' WHERE hash = ?", &[&key]).await;
    let deleted = as_person(&api, api.request(axum::http::Method::DELETE, "/api/me").json(json!({"confirm": " ANA "})), "ana").await.send().await;
    assert_eq!(deleted.status, 204, "{}", deleted.body);
    assert!(deleted.header("set-cookie").is_some_and(|c| c.contains("Max-Age=0")), "{:?}", deleted.headers);
    for (what, query) in [
        ("the workspace", "SELECT count(*) AS n FROM workspaces WHERE id = 'ana-side'"),
        ("its members", "SELECT count(*) AS n FROM workspace_members WHERE workspace = 'ana-side'"),
        ("its project", "SELECT count(*) AS n FROM projects WHERE workspace = 'ana-side'"),
        ("its issues", "SELECT count(*) AS n FROM issues WHERE title = 'Plan'"),
        ("its epics", "SELECT count(*) AS n FROM epics WHERE workspace = 'ana-side'"),
        ("its settings", "SELECT count(*) AS n FROM workspace_settings WHERE workspace = 'ana-side'"),
        ("its statuses", "SELECT count(*) AS n FROM statuses WHERE workspace = 'ana-side'"),
        ("its agent keys", "SELECT count(*) AS n FROM keys WHERE workspace = 'ana-side'"),
        ("her logins", "SELECT count(*) AS n FROM logins WHERE person = 'ana'"),
        ("her sign-in accounts", "SELECT count(*) AS n FROM identities WHERE person = 'ana'"),
        ("her memberships", "SELECT count(*) AS n FROM workspace_members WHERE person = 'ana'"),
    ] {
        assert_eq!(api.count(query).await, 0, "{what}");
    }
    assert_eq!(api.count("SELECT count(*) AS n FROM people WHERE id = 'ana'").await, 0);
    assert_eq!(api.count("SELECT count(*) AS n FROM people WHERE name = 'Deleted person' AND removed_at IS NOT NULL").await, 1);
    // Who stays is as they were: bo, in default, and the owner's workspace with its project.
    assert_eq!(api.count("SELECT count(*) AS n FROM workspace_members WHERE person = 'bo'").await, 1);
    assert_eq!(api.count("SELECT count(*) AS n FROM workspaces WHERE id = 'default'").await, 1);
    // The project went the way deleting it goes, told to open pages.
    assert!(api.outbox().await.iter().any(|c| c.project.as_deref() == Some(side.as_str())), "{:?}", api.outbox().await);
}

#[tokio::test]
async fn leaves_others_workspaces_but_takes_her_name_off_what_she_left_there() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = workspace(&api, "bo-works", "bo", &["ana"], "Rockets").await;
    let fuel = api.issue(&rockets, json!({"title": "Fuel", "assignee": "ana"})).await;
    api.run("UPDATE issues SET created_by = 'ana', decided_by = 'Ana' WHERE id = ?", &[&fuel]).await;
    api.run(
        "INSERT INTO comments (project, issue, body, created_by, person, created_at, updated_at) VALUES (?, ?, 'Ready', 'ana', 'ana', 'x', 'x')",
        &[&rockets, &fuel],
    )
    .await;
    // A login of hers, made while she's here, to try once she's gone.
    let again = as_person(&api, api.get("/api/me"), "ana").await.header("orrery-login-ways", "on, provider");
    let deleted = as_person(&api, api.request(axum::http::Method::DELETE, "/api/me").json(json!({"confirm": "ana"})), "ana").await.send().await;
    assert_eq!(deleted.status, 204, "{}", deleted.body);
    // bo's workspace stays, with what she did in it.
    assert_eq!(api.count("SELECT count(*) AS n FROM workspaces WHERE id = 'bo-works'").await, 1);
    let issue = api.get(&format!("/api/projects/{rockets}/issues/{fuel}")).send().await;
    assert_eq!(issue.status, 200, "{}", issue.body);
    assert!(issue.body["assignee"].is_null(), "{}", issue.body);
    assert!(api.outbox().await.iter().any(|c| c.kind == "issue.assignee"), "{:?}", api.outbox().await);
    // But not her name, nor the id made from it: a "Deleted person" did it, under an id that says nothing of her.
    let people = api.get("/api/people").send().await;
    let gone = people.body.as_array().unwrap().iter().find(|p| p["name"] == "Deleted person").cloned().unwrap();
    assert!(gone["removed_at"].is_string());
    let erased = gone["id"].as_str().unwrap().to_owned();
    assert!(erased.starts_with("deleted_") && !erased.contains("ana"), "{erased}");
    assert!(!people.body.to_string().contains("\"ana\""), "{}", people.body);
    assert_eq!(api.count(&format!("SELECT count(*) AS n FROM issues WHERE created_by = '{erased}' AND decided_by = '{erased}'")).await, 1);
    assert_eq!(api.count(&format!("SELECT count(*) AS n FROM comments WHERE body = 'Ready' AND created_by = '{erased}' AND person = '{erased}'")).await, 1);
    assert_eq!(
        api.count(&format!("SELECT count(*) AS n FROM issue_events WHERE field = 'assignee' AND \"before\" = '{erased}' AND \"after\" IS NULL")).await,
        1
    );
    for (table, column) in [
        ("issues", "created_by"),
        ("issues", "assignee"),
        ("comments", "person"),
        ("issue_events", "created_by"),
        ("issue_events", "\"before\""),
        ("keys", "person"),
    ] {
        assert_eq!(api.count(&format!("SELECT count(*) AS n FROM {table} WHERE lower({column}) = 'ana'")).await, 0, "{table}.{column}");
    }
    // A login of hers no longer gets her in.
    let again = again.send().await;
    assert_eq!(again.status, 401, "{}", again.body);
}

#[tokio::test]
async fn the_owner_deletes_themselves_and_the_longest_here_takes_the_orrery() {
    let api = TestApi::new().await;
    api.team().await;
    let (primes, _) = api.board().await;
    let deleted = as_person(&api, api.request(axum::http::Method::DELETE, "/api/me").json(json!({"confirm": "Sam"})), "sam").await.send().await;
    assert_eq!(deleted.status, 204, "{}", deleted.body);
    // `default` is emptied, not deleted: the server needs it.
    assert_eq!(api.count("SELECT count(*) AS n FROM workspaces WHERE id = 'default'").await, 1);
    assert_eq!(api.count(crate::db::sql("SELECT count(*) AS n FROM projects").as_str()).await, 0, "{primes}");
    assert!(api.count("SELECT count(*) AS n FROM statuses WHERE workspace = 'default'").await > 0);
    // ana and bo joined together: ana, first by id, owns the orrery now, and `default`.
    assert_eq!(api.get("/api/owner").send().await.body["name"], "ana");
    assert_eq!(api.count("SELECT count(*) AS n FROM people WHERE role = 'owner'").await, 1);
    assert_eq!(api.count("SELECT count(*) AS n FROM workspace_members WHERE workspace = 'default' AND person = 'ana' AND role = 'owner'").await, 1);
    // And the server goes on: she makes a project.
    let made = as_person(&api, api.post("/api/projects", json!({"name": "Fresh"})), "ana").await.send().await;
    assert_eq!(made.status, 201, "{}", made.body);
}

#[tokio::test]
async fn the_last_owner_leaving_frees_the_orrery_for_the_next_sign_in() {
    let api = TestApi::new().await;
    api.owner().await;
    api.run("INSERT INTO identities (issuer, subject, person) VALUES ('https://id.example', '1', 'sam')", &[]).await;
    let deleted = as_person(&api, api.request(axum::http::Method::DELETE, "/api/me").json(json!({"confirm": "sam"})), "sam").await.send().await;
    assert_eq!(deleted.status, 204, "{}", deleted.body);
    assert_eq!(api.get("/api/owner").send().await.body["named"], false);
    // The same account signing in again is someone new, the owner now. `sam` is free again, as history no longer has it.
    let again = api.post("/api/auth/identity", json!({"issuer": "https://id.example", "subject": "1", "name": "Sam"})).send().await;
    assert_eq!(again.status, 200, "{}", again.body);
    assert_eq!(again.body["person"], "sam");
    let owner = api.get("/api/owner").send().await;
    assert_eq!((owner.body["name"].as_str(), owner.body["named"].as_bool()), (Some("sam"), Some(true)));
    assert_eq!(api.count("SELECT count(*) AS n FROM workspace_members WHERE workspace = 'default' AND person = 'sam' AND role = 'owner'").await, 1);
}

#[tokio::test]
async fn deletes_a_workspace_she_owns_on_its_own_with_everything_in_it() {
    let api = TestApi::new().await;
    api.team().await;
    let side = workspace(&api, "ana-side", "ana", &["bo"], "Side").await;
    api.issue(&side, json!({"title": "Plan"})).await;
    let delete = |who: &'static str, workspace: &'static str, confirm: &'static str| {
        let api = &api;
        async move {
            as_person(api, api.request(axum::http::Method::DELETE, &format!("/api/workspaces/{workspace}")).json(json!({"confirm": confirm})), who)
                .await
                .send()
                .await
        }
    };
    // Only with its name typed, only by its owner, and never `default`; one she isn't in is as one that isn't there.
    assert_eq!(delete("ana", "ana-side", "side").await.status, 400);
    assert_eq!(delete("bo", "ana-side", "ana-side").await.status, 403);
    assert_eq!(delete("sam", "default", "Default").await.status, 409);
    workspace(&api, "bo-works", "bo", &[], "Rockets").await;
    assert_eq!(delete("ana", "bo-works", "bo-works").await.status, 404);
    assert_eq!(api.count("SELECT count(*) AS n FROM issues WHERE title = 'Plan'").await, 1);
    let deleted = delete("ana", "ana-side", " ANA-SIDE ").await;
    assert_eq!(deleted.status, 204, "{}", deleted.body);
    for (what, query) in [
        ("the workspace", "SELECT count(*) AS n FROM workspaces WHERE id = 'ana-side'"),
        ("its members", "SELECT count(*) AS n FROM workspace_members WHERE workspace = 'ana-side'"),
        ("its project", "SELECT count(*) AS n FROM projects WHERE workspace = 'ana-side'"),
        ("its issues", "SELECT count(*) AS n FROM issues WHERE title = 'Plan'"),
    ] {
        assert_eq!(api.count(query).await, 0, "{what}");
    }
    // She's still here, as is everything else.
    assert_eq!(api.count("SELECT count(*) AS n FROM people WHERE id = 'ana' AND removed_at IS NULL").await, 1);
    assert_eq!(api.count("SELECT count(*) AS n FROM workspaces WHERE id = 'bo-works'").await, 1);
    // A session can't, even with her key.
    let key = api.key("ana", "agent").await;
    workspace(&api, "ana-two", "ana", &[], "Two").await;
    let agent = api
        .request(axum::http::Method::DELETE, "/api/workspaces/ana-two")
        .json(json!({"confirm": "ana-two"}))
        .header("orrery-came", "loopback")
        .header("orrery-login-ways", "on")
        .header("orrery-key", &key)
        .send()
        .await;
    assert_eq!(agent.status, 403, "{}", agent.body);
}
