// What the rails hold a write to (ORR-1059), sent straight to the API with no Nuxt in front: the chat's and an untrusted
// session's columns, and on an orrery with more than one person, the member column and the board the route names.
use super::*;
use crate::db::sql;
use crate::testing::{Req, TestApi};
use serde_json::json;

async fn on_board(api: &TestApi, project: &str, person: &str) {
    sqlx::query(&sql("INSERT INTO project_members (project, person, role, created_at) VALUES (?, ?, 'member', '2026-11-01')"))
        .bind(project)
        .bind(person)
        .execute(&api.app.pool)
        .await
        .unwrap();
}

/// An agent's request, as the router sends one (`Orrery-Actor-Asked`), its session naming `person` if any.
fn agent(req: Req, person: Option<&str>) -> Req {
    let req = req.by_agent("claude").header("orrery-actor-asked", "1").header("orrery-actor-kind", "session");
    match person {
        Some(person) => req.header("orrery-actor-named", person),
        None => req,
    }
}

fn kind(req: Req, kind: &str) -> Req {
    req.by_agent("claude").header("orrery-actor-asked", "1").header("orrery-actor-kind", kind)
}

#[test]
fn the_table_reads() {
    assert!(PERMISSIONS.iter().any(|p| p.id == "issues.create"));
}

#[test]
fn matches_a_route_as_guard_ts_does() {
    let params = match_route("POST /api/projects/:project/issues/:issue/comments", "POST", "/api/projects/a%20b/issues/ORR-1/comments/").unwrap();
    assert_eq!(params["project"], "a b");
    assert_eq!(params["issue"], "ORR-1");
    assert!(match_route("POST /api/projects/:project/issues", "PATCH", "/api/projects/a/issues").is_none());
    assert!(match_route("POST /api/projects/:project/issues", "POST", "/api/projects/a/issues/x").is_none());
    assert!(match_route("POST /api/projects/:project/issues", "POST", "/api/projects//issues").is_none());
}

#[tokio::test]
async fn with_one_person_an_agent_naming_nobody_writes() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let reply = agent(api.post(&format!("/api/projects/{project}/issues"), json!({"title": "Sieve"})), None).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
}

#[tokio::test]
async fn with_more_a_session_naming_nobody_cant_let_a_claim_go_or_edit_a_comment_but_can_comment() {
    let api = TestApi::new().await;
    api.team().await;
    let project = api.project("Primes").await;
    let issue = api.issue(&project, json!({"title": "Sieve"})).await;
    let at = format!("/api/projects/{project}/issues/{issue}");
    let made = agent(api.post(&format!("{at}/comments"), json!({"body": "Seen it"})), None).send().await;
    assert_eq!(made.status, 201, "commenting stays open: {}", made.body);
    let comment = made.body["id"].to_string();
    for reply in [
        agent(api.delete(&format!("{at}/claim")), None).send().await,
        agent(api.patch(&format!("{at}/comments/{comment}"), json!({"body": "Changed"})), None).send().await,
    ] {
        assert_eq!(reply.status, 409, "{}", reply.body);
        assert!(reply.body["message"].as_str().unwrap().starts_with("This session names nobody, and this orrery has more than one person"), "{}", reply.body);
    }
    let named = agent(api.delete(&format!("{at}/claim")), Some("nobody-here")).send().await;
    assert!(named.body["message"].as_str().unwrap().starts_with("\"nobody-here\" isn't anyone on this orrery"), "{}", named.body);
}

#[tokio::test]
async fn a_member_off_the_board_is_told_theres_no_such_project() {
    let api = TestApi::new().await;
    api.team().await;
    let project = api.project("Primes").await;
    let reply = agent(api.post(&format!("/api/projects/{project}/issues"), json!({"title": "Sieve"})), Some("ana")).send().await;
    assert_eq!(reply.status, 404, "{}", reply.body);
    assert_eq!(reply.body["message"], json!(format!("No project {project}")));
    on_board(&api, &project, "ana").await;
    let reply = agent(api.post(&format!("/api/projects/{project}/issues"), json!({"title": "Sieve"})), Some("ana")).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
}

#[tokio::test]
async fn a_member_on_the_board_cant_do_what_is_the_owners() {
    let api = TestApi::new().await;
    api.team().await;
    let project = api.project("Primes").await;
    on_board(&api, &project, "ana").await;
    let issue = api.issue(&project, json!({"title": "Sieve", "proposal": "pending"})).await;
    let reply = agent(api.post(&format!("/api/projects/{project}/issues/{issue}/decide"), json!({"decision": "approved"})), Some("ana")).send().await;
    assert_eq!(reply.status, 403, "{}", reply.body);
    assert_eq!(reply.body["data"]["permission"], "proposals.decide");
    assert!(reply.body["message"].as_str().unwrap().contains("the owner's alone for now, or past what ana may on this board"), "{}", reply.body);
}

#[tokio::test]
async fn with_more_a_route_the_table_doesnt_name_is_refused_unless_the_server_itself_writes() {
    let api = TestApi::new().await;
    api.team().await;
    let reply = agent(api.put("/api/chats/c1", json!({})), Some("ana")).send().await;
    assert_eq!(reply.status, 403, "{}", reply.body);
    assert!(reply.body["message"].as_str().unwrap().starts_with("Nobody has said who may PUT /api/chats/c1"), "{}", reply.body);
    // The Nuxt server keeping the chat's row, as `orrery` (`writeToApi`), isn't a request.
    let kept = api.put("/api/chats/c1", json!({})).by_agent("orrery").send().await;
    assert_ne!(kept.status, 403, "{}", kept.body);
}

#[tokio::test]
async fn the_chat_is_held_to_its_column_whoever_it_names() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let issue = api.issue(&project, json!({"title": "Sieve"})).await;
    let at = format!("/api/projects/{project}/issues/{issue}");
    let claim = kind(api.post(&format!("{at}/claim"), json!({})), "chat").header("orrery-actor-owner", "1").send().await;
    assert_eq!(claim.status, 403, "{}", claim.body);
    assert_eq!(claim.body["data"]["permission"], "issues.claim");
    assert!(claim.body["message"].as_str().unwrap().starts_with("This session is the owner's chat"), "{}", claim.body);
    let many = kind(api.patch(&format!("/api/projects/{project}/issues"), json!({"ids": [issue], "set": {"priority": "P1"}})), "chat").send().await;
    assert_eq!(many.status, 403, "the chat edits one issue, never many at once: {}", many.body);
    let comment = kind(api.post(&format!("{at}/comments"), json!({"body": "Noted"})), "chat").send().await;
    assert_eq!(comment.status, 201, "{}", comment.body);
}

#[tokio::test]
async fn an_untrusted_session_comments_only_on_its_own_external_proposals() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let plain = api.issue(&project, json!({"title": "Sieve"})).await;
    let theirs = api.issue(&project, json!({"title": "From outside", "labels": ["external"], "proposal": "pending"})).await;
    let mine = api.issue(&project, json!({"title": "Owner's", "proposal": "pending"})).await;
    let comment = |issue: &str| kind(api.post(&format!("/api/projects/{project}/issues/{issue}/comments"), json!({"body": "Hi"})), "untrusted");
    for issue in [&plain, &mine] {
        let reply = comment(issue).send().await;
        assert_eq!((reply.status.as_u16(), &reply.body["data"]["permission"]), (403, &json!("comments.write")), "{issue}: {}", reply.body);
    }
    let reply = comment(&theirs).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let edit = kind(api.patch(&format!("/api/projects/{project}/issues/{theirs}"), json!({"title": "Pwned"})), "untrusted").send().await;
    assert_eq!(edit.status, 403, "{}", edit.body);
}

#[tokio::test]
async fn only_the_boards_holder_passes_its_check() {
    let api = TestApi::new().await;
    api.team().await;
    let project = api.project("Primes").await;
    on_board(&api, &project, "ana").await;
    sqlx::query(&sql("UPDATE project_members SET role = 'owner' WHERE project = ? AND person = 'steffen'"))
        .bind(&project)
        .execute(&api.app.pool)
        .await
        .unwrap();
    sqlx::query(&sql("INSERT INTO project_members (project, person, role, created_at) SELECT ?, 'steffen', 'owner', '2026-11-01' WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project = ? AND person = 'steffen')"))
        .bind(&project)
        .bind(&project)
        .execute(&api.app.pool)
        .await
        .unwrap();
    let mut conn = api.app.pool.acquire().await.unwrap();
    let params = HashMap::from([("project".to_string(), project.clone())]);
    assert!(check(&mut conn, "boardHolder", &params, Some("steffen")).await.unwrap());
    assert!(!check(&mut conn, "boardHolder", &params, Some("ana")).await.unwrap());
    assert!(!check(&mut conn, "boardHolder", &params, None).await.unwrap());
    assert!(!check(&mut conn, "ownSession", &params, Some("steffen")).await.unwrap(), "the sessions are the local app's");
}

#[tokio::test]
async fn an_untrusted_session_writes_only_to_the_project_it_was_started_for() {
    // The router says which (`Orrery-Untrusted-Project`) once it knows the session (ORR-1069), as for /mcp's tools (ORR-1102).
    let api = TestApi::new().await;
    let own = api.project("Primes").await;
    let other = api.project("Sieves").await;
    let raise = |project: &str| {
        kind(api.post(&format!("/api/projects/{project}/issues"), json!({"title": "From outside"})), "untrusted").header("orrery-untrusted-project", &own)
    };
    let there = raise(&other).send().await;
    assert_eq!(there.status, 403, "{}", there.body);
    assert!(there.body["message"].as_str().unwrap().ends_with(&format!("for {own}, so it only writes there")), "{}", there.body);
    let here = raise(&own).send().await;
    assert_eq!(here.status, 201, "{}", here.body);
    // Before the router knows the session, its column alone holds it, as middleware/untrusted.ts does.
    let unknown = kind(api.post(&format!("/api/projects/{other}/issues"), json!({"title": "From outside"})), "untrusted").send().await;
    assert_eq!(unknown.status, 201, "{}", unknown.body);
}

// The workspace a project is in holds its reads and writes (ORR-1106, decision 6): a person who isn't a member of it,
// the owner too, gets a 404 as if it weren't here; a request naming nobody here sees only `default`.

/// A second workspace, Acme, with project Rockets in it and `members` in it: the project's id.
async fn acme(api: &TestApi, members: &[&str]) -> String {
    api.run("INSERT INTO workspaces (id, name, created_at) VALUES ('acme', 'Acme', ?)", &[STAMP_NOW]).await;
    let project = api.project("Rockets").await;
    api.run("UPDATE projects SET workspace = 'acme' WHERE id = ?", &[&project]).await;
    for member in members {
        api.run("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES ('acme', ?, 'member', ?)", &[member, STAMP_NOW]).await;
    }
    project
}

const STAMP_NOW: &str = "2026-11-14T00:00:00.000Z";

/// As a request from outside comes through the router, over loopback with ORRERY_AUTH=off, rather than the Nuxt
/// server's own work: it names nobody but what its actor headers say.
fn from_outside(req: Req) -> Req {
    req.header("orrery-came", "loopback").header("orrery-login-ways", "off")
}

/// As a browser signed in as `person` asks, through the router with login on: the API finds who it is from the login.
async fn signed(api: &TestApi, req: Req, person: &str) -> Req {
    let login = api.login(person).await;
    req.header("orrery-came", "loopback").header("orrery-login-ways", "on").signed_in(&login)
}

#[tokio::test]
async fn a_person_outside_a_workspace_neither_reads_nor_writes_its_projects() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = acme(&api, &["bo"]).await;
    let read = signed(&api, api.get(&format!("/api/projects/{rockets}/issues")).by_agent("ana"), "ana").await.send().await;
    assert_eq!(read.status, 404, "{}", read.body);
    let wrote = signed(&api, api.post(&format!("/api/projects/{rockets}/issues"), json!({"title": "Fuel"})).person("ana"), "ana").await.send().await;
    assert_eq!(wrote.status, 404, "{}", wrote.body);
    let theirs = signed(&api, api.get(&format!("/api/projects/{rockets}/issues")).by_agent("bo"), "bo").await.send().await;
    assert_eq!(theirs.status, 200, "{}", theirs.body);
}

#[tokio::test]
async fn the_owner_sees_only_the_workspaces_they_are_in() {
    let api = TestApi::new().await;
    api.team().await;
    let primes = api.project("Primes").await;
    let rockets = acme(&api, &["bo"]).await;
    let theirs = signed(&api, api.get(&format!("/api/projects/{rockets}/issues")), "steffen").await.send().await;
    assert_eq!(theirs.status, 404, "{}", theirs.body);
    let own = signed(&api, api.get(&format!("/api/projects/{primes}/issues")), "steffen").await.send().await;
    assert_eq!(own.status, 200, "{}", own.body);
    // Their own sessions and chat, with login off, are theirs.
    let chat = from_outside(api.get(&format!("/api/projects/{rockets}/issues")).header("orrery-actor-kind", "chat")).send().await;
    assert_eq!(chat.status, 404, "{}", chat.body);
}

#[tokio::test]
async fn a_request_naming_nobody_here_sees_only_default() {
    let api = TestApi::new().await;
    api.team().await;
    let primes = api.project("Primes").await;
    let rockets = acme(&api, &["bo"]).await;
    let nobody = |path: String| from_outside(api.get(&path).agent_of_nobody());
    assert_eq!(nobody(format!("/api/projects/{primes}/issues")).send().await.status, 200);
    assert_eq!(nobody(format!("/api/projects/{rockets}/issues")).send().await.status, 404);
    let stranger = from_outside(api.get(&format!("/api/projects/{rockets}/issues")).agent_of("zed")).send().await;
    assert_eq!(stranger.status, 404, "{}", stranger.body);
    let bos = from_outside(api.get(&format!("/api/projects/{rockets}/issues")).agent_of("bo")).send().await;
    assert_eq!(bos.status, 200, "{}", bos.body);
}

#[tokio::test]
async fn the_nuxt_servers_own_work_and_a_missing_project_are_not_held() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = acme(&api, &[]).await;
    let own = api.get(&format!("/api/projects/{rockets}/issues")).send().await;
    assert_eq!(own.status, 200, "{}", own.body);
    let gone = from_outside(api.get("/api/projects/nowhere/issues").agent_of_nobody()).send().await;
    assert_eq!(gone.status, 404, "{}", gone.body);
}

#[tokio::test]
async fn an_untrusted_session_reaches_the_project_it_was_started_for() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = acme(&api, &[]).await;
    let reply = from_outside(api.get(&format!("/api/projects/{rockets}/issues")).untrusted().header("orrery-untrusted-project", &rockets)).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let elsewhere = from_outside(api.get(&format!("/api/projects/{rockets}/issues")).untrusted()).send().await;
    assert_eq!(elsewhere.status, 404, "{}", elsewhere.body);
}
