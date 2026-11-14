// The lists and feeds across projects keep only the asker's workspaces (ORR-1106): ana is in `default` alone, bo in
// `default` and Acme, and the owner, steffen, in `default` alone, so neither ana nor the owner sees Acme's Rockets.
use super::*;
use crate::testing::{from_outside, ids, TestApi};
use serde_json::json;

/// The team, Primes in `default` and Rockets in Acme with bo in it: (primes, rockets).
async fn two_workspaces(api: &TestApi) -> (String, String) {
    api.team().await;
    let primes = api.project("Primes").await;
    let rockets = api.acme(&["bo"]).await;
    (primes, rockets)
}

/// `path` as `person` asks it, signed in, through the router: its body.
async fn as_person(api: &TestApi, path: &str, person: &str) -> Value {
    let reply = api.signed(api.get(path), person).await.send().await;
    assert_eq!(reply.status, 200, "{path}: {}", reply.body);
    reply.body
}

/// The `project` of each entry in a list.
fn projects_of(list: &Value) -> Vec<String> {
    list.as_array().expect("a list").iter().map(|e| e["project"].as_str().unwrap_or("-").to_string()).collect()
}

#[test]
fn keeping_drops_only_the_projects_hidden() {
    let hidden: HashSet<String> = ["rockets".to_string()].into();
    let mut list = json!([{"project": "primes"}, {"project": "rockets"}, {"kind": "server"}, {"project": null}, {"project": "gone"}]);
    keep_in(&hidden, &mut list, "project");
    assert_eq!(list, json!([{"project": "primes"}, {"kind": "server"}, {"project": null}, {"project": "gone"}]));
}

#[tokio::test]
async fn the_projects_list_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    assert_eq!(ids(&as_person(&api, "/api/projects", "ana").await), std::slice::from_ref(&primes));
    assert_eq!(ids(&as_person(&api, "/api/projects", "steffen").await), std::slice::from_ref(&primes));
    let mut bos = ids(&as_person(&api, "/api/projects", "bo").await);
    bos.sort();
    assert_eq!(bos, [primes.clone(), rockets.clone()]);
    // The Nuxt server's own work sees every one; a request naming nobody here, only `default`'s.
    assert_eq!(ids(&api.get("/api/projects").send().await.body).len(), 2);
    assert_eq!(ids(&from_outside(api.get("/api/projects").agent_of_nobody()).send().await.body), [primes]);
}

#[tokio::test]
async fn the_changes_feed_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    api.issue(&primes, json!({"title": "Sieve"})).await;
    api.issue(&rockets, json!({"title": "Fuel"})).await;
    let anas = as_person(&api, "/api/changes", "ana").await;
    let seen = projects_of(&anas["changes"]);
    assert!(seen.contains(&primes) && !seen.contains(&rockets), "{seen:?}");
    let bos = projects_of(&as_person(&api, "/api/changes", "bo").await["changes"]);
    assert!(bos.contains(&rockets), "{bos:?}");
    // Where to carry on from is the feed's, whatever was held back.
    assert_eq!(anas["last"], api.get("/api/changes").send().await.body["last"]);
}

#[tokio::test]
async fn the_schedules_agenda_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    for (project, title) in [(&primes, "Primes job"), (&rockets, "Rockets job")] {
        api.run(
            "INSERT INTO schedules (project, title, timezone, cron, created_by, created_at, updated_at) VALUES (?, ?, 'Europe/Oslo', '0 9 * * 1', 'owner', ?, ?)",
            &[project, title, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
        )
        .await;
    }
    assert_eq!(projects_of(&as_person(&api, "/api/schedules", "ana").await), std::slice::from_ref(&primes));
    assert_eq!(projects_of(&as_person(&api, "/api/schedules", "bo").await).len(), 2);
}

#[tokio::test]
async fn a_schedule_across_projects_shows_only_the_askers_projects() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let both = format!("[\"{primes}\",\"{rockets}\"]");
    let theirs = format!("[\"{rockets}\"]");
    for (projects, on) in [(&both, vec![&primes, &rockets]), (&theirs, vec![&rockets])] {
        let id: i64 = sqlx::query_scalar(&sql(
            "INSERT INTO schedules_across (projects, body, created_by, created_at, updated_at) VALUES (?, '{\"title\":\"Tidy\"}', 'owner', '2026-11-03', '2026-11-03') RETURNING id",
        ))
        .bind(projects)
        .fetch_one(&api.app.pool)
        .await
        .unwrap();
        for project in on {
            api.run(
                // The id written in, not bound: a bound one is text, which Postgres won't put in an integer column.
                &format!(
                    "INSERT INTO schedules (project, title, timezone, cron, across, created_by, created_at, updated_at) VALUES (?, 'Tidy', 'Europe/Oslo', '0 9 * * 1', {id}, 'owner', ?, ?)"
                ),
                &[project, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
            )
            .await;
        }
    }
    let anas = as_person(&api, "/api/schedules/across", "ana").await;
    assert_eq!(anas.as_array().unwrap().len(), 1, "{anas}");
    assert_eq!(anas[0]["on_projects"], json!([primes]));
    assert_eq!(as_person(&api, "/api/schedules/across", "bo").await.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn the_event_log_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let at = "2026-11-14T00:00:00.000Z";
    for project in [&primes, &rockets] {
        api.run(
            "INSERT INTO events (level, kind, project, message, count, first_seen, last_seen) VALUES ('info', 'note', ?, 'Moved', 1, ?, ?)",
            &[project, at, at],
        )
        .await;
    }
    api.run("INSERT INTO events (level, kind, message, count, first_seen, last_seen) VALUES ('info', 'note', 'Started', 1, ?, ?)", &[at, at]).await;
    let mut anas = projects_of(&as_person(&api, "/api/events/log", "ana").await);
    anas.sort();
    assert_eq!(anas, ["-".to_string(), primes]);
    assert_eq!(as_person(&api, "/api/events/log", "bo").await.as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn the_releases_hold_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    api.run("UPDATE projects SET release_mode = 'own'", &[]).await;
    assert_eq!(projects_of(&as_person(&api, "/api/releases", "ana").await), std::slice::from_ref(&primes));
    let mut bos = projects_of(&as_person(&api, "/api/releases", "bo").await);
    bos.sort();
    assert_eq!(bos, [primes, rockets]);
}

#[tokio::test]
async fn the_bell_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    for project in [&primes, &rockets] {
        let made = api.post(&format!("/api/projects/{project}/issues"), json!({"title": "Maybe", "proposal": "pending"})).by_agent("claude").send().await;
        assert_eq!(made.status, 201, "{}", made.body);
    }
    let all = projects_of(&api.get("/api/notices").browser("steffen", true).send().await.body);
    assert!(all.contains(&rockets), "the Nuxt server's own work sees every workspace: {all:?}");
    let owners = from_outside(api.get("/api/notices").header("orrery-actor-owner", "1").header("orrery-actor-name", "steffen")).send().await;
    assert_eq!(owners.status, 200, "{}", owners.body);
    assert_eq!(projects_of(&owners.body), std::slice::from_ref(&primes));
    let changes =
        from_outside(api.get("/api/notices/changes?since=2026-01-01T00:00:00.000Z").header("orrery-actor-owner", "1").header("orrery-actor-name", "steffen"))
            .send()
            .await;
    assert_eq!(changes.status, 200, "{}", changes.body);
    assert!(!projects_of(&changes.body).contains(&rockets), "{}", changes.body);
}

// An agent key belongs to a person in one workspace, so a session's key reaches only that workspace (ORR-1106).

/// `req` with `person`'s agent key for `workspace` (none for a key from before workspaces), through the router with
/// login on.
async fn with_agent_key(api: &TestApi, req: crate::testing::Req, person: &str, workspace: Option<&str>) -> crate::testing::Req {
    let key = api.key(person, "agent").await;
    if let Some(workspace) = workspace {
        api.run("UPDATE keys SET workspace = ? WHERE hash = ?", &[workspace, &key]).await;
    }
    req.header("orrery-came", "loopback").header("orrery-login-ways", "on").header("orrery-key", &key)
}

#[tokio::test]
async fn an_agent_key_reaches_only_its_own_workspace() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let read = |project: &String| api.get(&format!("/api/projects/{project}/issues"));
    let home = with_agent_key(&api, read(&primes), "bo", Some("default")).await.send().await;
    assert_eq!(home.status, 200, "{}", home.body);
    // bo is in Acme, but this key is for `default`.
    let away = with_agent_key(&api, read(&rockets), "bo", Some("default")).await.send().await;
    assert_eq!(away.status, 404, "{}", away.body);
    let acmes = with_agent_key(&api, read(&rockets), "bo", Some("acme")).await.send().await;
    assert_eq!(acmes.status, 200, "{}", acmes.body);
    let listed = with_agent_key(&api, api.get("/api/projects"), "bo", Some("acme")).await.send().await;
    assert_eq!(ids(&listed.body), std::slice::from_ref(&rockets));
    let wrote = with_agent_key(&api, api.post(&format!("/api/projects/{primes}/issues"), json!({"title": "Sieve"})), "bo", Some("acme")).await.send().await;
    assert_eq!(wrote.status, 404, "{}", wrote.body);
}

#[tokio::test]
async fn an_agent_key_from_before_workspaces_reaches_its_persons() {
    let api = TestApi::new().await;
    let (_, rockets) = two_workspaces(&api).await;
    let reply = with_agent_key(&api, api.get(&format!("/api/projects/{rockets}/issues")), "bo", None).await.send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
}

#[tokio::test]
async fn a_new_agent_key_is_for_one_of_its_persons_workspaces() {
    let api = TestApi::new().await;
    two_workspaces(&api).await;
    let make = |body: Value, person: &'static str| {
        let api = &api;
        async move { api.signed(api.post("/api/keys", body).header("orrery-sent-origin", "http://localhost"), person).await.send().await }
    };
    let made = make(json!({"kind": "agent", "name": "Laptop"}), "bo").await;
    assert_eq!((made.status.as_u16(), made.body["workspace"].as_str()), (201, Some("default")), "{}", made.body);
    let acmes = make(json!({"kind": "agent", "name": "Rig", "workspace": "acme"}), "bo").await;
    assert_eq!((acmes.status.as_u16(), acmes.body["workspace"].as_str()), (201, Some("acme")), "{}", acmes.body);
    let outside = make(json!({"kind": "agent", "name": "Rig", "workspace": "acme"}), "ana").await;
    assert_eq!(outside.status, 404, "{}", outside.body);
    let person = make(json!({"kind": "person", "name": "Phone"}), "bo").await;
    assert_eq!((person.status.as_u16(), person.body.get("workspace")), (201, None), "a person key is above every workspace: {}", person.body);
    let listed = api.signed(api.get("/api/keys"), "bo").await.send().await;
    assert!(listed.body.as_array().unwrap().iter().any(|k| k["workspace"] == "acme"), "{}", listed.body);
}

// Every route of a project, read from the routes' own source so a new one is held too: someone outside its workspace
// gets the workspace's 404 on each, read or write (ORR-1106, ORR-1052).

/// `(method, path)` for each route under `/api/projects/{project}` in src/routes.
fn project_routes() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/routes");
    let mut routes = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".rs") || name.ends_with("_tests.rs") {
            continue;
        }
        for line in std::fs::read_to_string(&path).unwrap().lines() {
            let Some(at) = line.find(".route(") else { continue };
            let rest = &line[at + ".route(".len()..];
            // `.route(P, …)` is the project itself; else the path is the first string, `{P}/…` in a `format!`.
            let (route, methods) = if let Some(methods) = rest.strip_prefix("P,") {
                ("/api/projects/{project}".to_string(), methods)
            } else {
                let Some(open) = rest.find('"') else { continue };
                let Some(len) = rest[open + 1..].find('"') else { continue };
                let said = &rest[open + 1..open + 1 + len];
                (said.replace("{P}", "/api/projects/{project}").replace("{{", "{").replace("}}", "}"), &rest[open + 1 + len..])
            };
            if !route.starts_with("/api/projects/{project}") {
                continue;
            }
            for method in ["get", "post", "put", "patch", "delete"] {
                if methods.contains(&format!("{method}(")) {
                    routes.push((method.to_uppercase(), route.clone()));
                }
            }
        }
    }
    routes.sort();
    routes
}

/// `route` with `project` for `{project}` and a made-up value for each other part.
fn filled(route: &str, project: &str) -> String {
    route
        .split('/')
        .map(|part| match part {
            "{project}" => project.to_string(),
            p if p.starts_with('{') => "1".to_string(),
            p => p.to_string(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[test]
fn the_routes_of_a_project_are_all_found() {
    let routes = project_routes();
    assert!(routes.len() > 80, "{}", routes.len());
    for expected in [("GET", "/api/projects/{project}"), ("POST", "/api/projects/{project}/issues"), ("DELETE", "/api/projects/{project}/docs/{doc}")] {
        assert!(routes.iter().any(|(m, r)| (m.as_str(), r.as_str()) == expected), "{expected:?} in {routes:?}");
    }
}

#[tokio::test]
async fn no_route_of_a_project_reads_or_writes_across_workspaces() {
    let api = TestApi::new().await;
    let (_, rockets) = two_workspaces(&api).await;
    let login = api.login("ana").await;
    let held = format!("No project {rockets}");
    let mut leaks = Vec::new();
    for (method, route) in project_routes() {
        let path = filled(&route, &rockets);
        let req = api
            .request(method.parse().unwrap(), &path)
            .json(json!({}))
            .header("orrery-came", "loopback")
            .header("orrery-login-ways", "on")
            .header("orrery-sent-origin", "http://localhost")
            .signed_in(&login);
        let reply = req.send().await;
        if reply.status != 404 || reply.body["message"] != held {
            leaks.push(format!("{method} {route}: {} {}", reply.status, reply.body));
        }
    }
    assert!(leaks.is_empty(), "reached across workspaces:\n{}", leaks.join("\n"));
    // The same asks by a member of Rockets' workspace aren't held, so the 404s above are the workspace's.
    let bos = api.signed(api.get(&format!("/api/projects/{rockets}/issues")), "bo").await.send().await;
    assert_eq!(bos.status, 200, "{}", bos.body);
}

#[tokio::test]
async fn an_mcp_tool_reaches_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (_, rockets) = two_workspaces(&api).await;
    let issue = api.issue(&rockets, json!({"title": "Fuel"})).await;
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "issue", "arguments": {"id": issue}}});
    let anas = with_agent_key(&api, api.post("/mcp", body.clone()), "ana", Some("default")).await.send().await;
    assert_eq!(anas.body["result"]["isError"], true, "{}", anas.body);
    let bos = with_agent_key(&api, api.post("/mcp", body), "bo", Some("acme")).await.send().await;
    assert_ne!(bos.body["result"]["isError"], true, "{}", bos.body);
}
