// The lists and feeds across projects keep only the asker's workspaces (ORR-1106): ana is in `default` alone, bo in
// `default` and Acme, and the owner, sam, in `default` alone, so neither ana nor the owner sees Acme's Rockets.
use super::*;
use crate::testing::{from_outside, ids, TestApi};
use serde_json::json;

/// The team, Primes in `default` and Rockets in Acme with bo in it: (primes, rockets).
async fn two_workspaces(api: &TestApi) -> (String, String) {
    api.team().await;
    let primes = api.project("Primes").await;
    api.on_board(&primes, &["ana", "bo"]).await;
    let rockets = api.acme(&["bo"]).await;
    (primes, rockets)
}

/// `path` as `person` asks it, signed in, through the router: its body.
async fn as_person(api: &TestApi, path: &str, person: &str) -> Value {
    let reply = api.signed(api.get(path), person).await.send().await;
    assert_eq!(reply.status, 200, "{path}: {}", reply.body);
    reply.body
}

/// `path` as `person` asks it from a page in `workspace` (`/w/<workspace>/…`): its body.
async fn as_person_in(api: &TestApi, path: &str, person: &str, workspace: &str) -> Value {
    let reply = api.signed(api.get(path).header("orrery-workspace", workspace), person).await.send().await;
    assert_eq!(reply.status, 200, "{path} in {workspace}: {}", reply.body);
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
    assert_eq!(ids(&as_person(&api, "/api/projects", "sam").await), std::slice::from_ref(&primes));
    // bo is in both, and the list holds one at a time: `default` with none named (ORR-1251).
    assert_eq!(ids(&as_person(&api, "/api/projects", "bo").await), std::slice::from_ref(&primes));
    assert_eq!(ids(&as_person_in(&api, "/api/projects", "bo", "acme").await), std::slice::from_ref(&rockets));
    // `?every=1` lists every workspace they're in, as a launcher's stream reads it; still none of anyone else's.
    let mut bos = ids(&as_person(&api, "/api/projects?every=1", "bo").await);
    bos.sort();
    assert_eq!(bos, [primes.clone(), rockets.clone()]);
    assert_eq!(ids(&as_person(&api, "/api/projects?every=1", "ana").await), std::slice::from_ref(&primes));
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
    assert_eq!(projects_of(&as_person(&api, "/api/schedules", "bo").await), std::slice::from_ref(&primes));
    assert_eq!(projects_of(&as_person_in(&api, "/api/schedules", "bo", "acme").await), std::slice::from_ref(&rockets));
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
    // bo is in both workspaces, but the list holds the one asked in (ORR-1251): in `default`, the one on Primes too,
    // as ana sees it, and not the one on Rockets alone.
    assert_eq!(as_person(&api, "/api/schedules/across", "bo").await, anas);
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
    // bo is in Acme too, but the log holds the workspace asked in (ORR-1251).
    let mut bos = projects_of(&as_person(&api, "/api/events/log", "bo").await);
    bos.sort();
    assert_eq!(bos, anas);
}

#[tokio::test]
async fn the_releases_hold_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    api.run("UPDATE projects SET release_mode = 'own'", &[]).await;
    assert_eq!(projects_of(&as_person(&api, "/api/releases", "ana").await), std::slice::from_ref(&primes));
    assert_eq!(projects_of(&as_person(&api, "/api/releases", "bo").await), std::slice::from_ref(&primes));
    assert_eq!(projects_of(&as_person_in(&api, "/api/releases", "bo", "acme").await), [rockets]);
}

#[tokio::test]
async fn the_bell_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    for project in [&primes, &rockets] {
        let made = api.post(&format!("/api/projects/{project}/issues"), json!({"title": "Maybe", "proposal": "pending"})).by_agent("claude").send().await;
        assert_eq!(made.status, 201, "{}", made.body);
    }
    let all = projects_of(&api.get("/api/notices").browser("sam", true).send().await.body);
    assert!(all.contains(&rockets), "the Nuxt server's own work sees every workspace: {all:?}");
    let owners = from_outside(api.get("/api/notices").header("orrery-actor-owner", "1").header("orrery-actor-name", "sam")).send().await;
    assert_eq!(owners.status, 200, "{}", owners.body);
    assert_eq!(projects_of(&owners.body), std::slice::from_ref(&primes));
    let changes =
        from_outside(api.get("/api/notices/changes?since=2026-01-01T00:00:00.000Z").header("orrery-actor-owner", "1").header("orrery-actor-name", "sam"))
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

#[tokio::test]
async fn a_machines_agent_key_reaches_every_workspace_its_person_is_in() {
    use sha2::Digest;
    // Connected from its install line (ORR-1192): no workspace kept, so it reaches all of bo's, as bo's login does.
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let made = api
        .signed(
            api.post("/api/keys", json!({"kind": "agent", "name": "Laptop", "all_workspaces": true})).header("orrery-sent-origin", "http://localhost"),
            "bo",
        )
        .await
        .send()
        .await;
    assert_eq!((made.status.as_u16(), made.body.get("workspace")), (201, None), "{}", made.body);
    // The router sends the key on hashed (`Orrery-Key`), as the keys table keeps it.
    let key: String = sha2::Sha256::digest(made.body["key"].as_str().unwrap().as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    for project in [&primes, &rockets] {
        let read =
            api.get(&format!("/api/projects/{project}/issues")).header("orrery-came", "loopback").header("orrery-login-ways", "on").header("orrery-key", &key);
        let reply = read.send().await;
        assert_eq!(reply.status, 200, "{project}: {}", reply.body);
    }
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

/// A page names its address's workspace, and the projects list holds that one alone (ORR-1108); naming one the asker
/// isn't in changes nothing they'd see.
#[tokio::test]
async fn the_projects_list_holds_the_workspace_a_page_names() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let listed = |workspace: &'static str, person: &'static str| {
        let api = &api;
        async move { ids(&api.signed(api.get("/api/projects").header("orrery-workspace", workspace), person).await.send().await.body) }
    };
    assert_eq!(listed("acme", "bo").await, std::slice::from_ref(&rockets));
    assert_eq!(listed("default", "bo").await, std::slice::from_ref(&primes));
    assert_eq!(listed("acme", "ana").await, std::slice::from_ref(&primes), "ana isn't in Acme: she sees her own");
}

/// A page with no `/w/…` in its address names no workspace, and shows itself in `default`: the projects list holds
/// that one alone too, not every workspace the asker is in mixed together (ORR-1251).
#[tokio::test]
async fn the_projects_list_naming_none_holds_the_one_it_acts_in() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let bos = ids(&api.signed(api.get("/api/projects"), "bo").await.send().await.body);
    assert_eq!(bos, std::slice::from_ref(&primes), "bo is in both, and acts in default when none is named");
    let releases = api.signed(api.get("/api/releases"), "bo").await.send().await;
    assert!(!releases.body.to_string().contains(&format!("\"{rockets}\"")), "Acme's releases listed in default: {}", releases.body);
}

/// `/mcp`'s tools name only the projects the asker can see (ORR-1195), in the workspace the session is in
/// (ORR-1251), so another workspace's ids aren't listed, even one its person is in too.
#[tokio::test]
async fn mcp_tools_name_only_the_askers_projects() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    let anas = with_agent_key(&api, api.post("/mcp", body.clone()), "ana", Some("default")).await.send().await;
    assert!(!anas.body.to_string().contains(&format!("\"{rockets}\"")), "ana's tools name Acme's project: {}", anas.body);
    // A second board in Acme, so a tool there takes which project, and lists them.
    let comets = api
        .signed(api.post("/api/projects", json!({"name": "Comets"})).header("orrery-workspace", "acme").header("orrery-sent-origin", "http://localhost"), "bo")
        .await
        .send()
        .await;
    assert_eq!(comets.status, 201, "{}", comets.body);
    let in_acme = with_agent_key(&api, api.post("/mcp", body.clone()).header("orrery-workspace", "acme"), "bo", None).await.send().await;
    assert!(in_acme.body.to_string().contains(&format!("\"{rockets}\"")), "bo's tools in Acme should name it: {}", in_acme.body);
    assert!(!in_acme.body.to_string().contains(&format!("\"{primes}\"")), "bo's tools in Acme name default's project: {}", in_acme.body);
    let in_default = with_agent_key(&api, api.post("/mcp", body), "bo", None).await.send().await;
    assert!(!in_default.body.to_string().contains(&format!("\"{rockets}\"")), "bo's tools in default name Acme's: {}", in_default.body);
}

// Every route outside a project, read from the source the same way, says how it's held in routes-outside-projects.json
// (ORR-1222): to a workspace, to the person asking, to the server's owner, the same for everyone, by an unguessable
// link, or not routed at all (`local`, as only the local app reaches it). A route that isn't in the file fails here,
// and a held one has to name the test that proves it. web/test/api-router-workspace.test.ts holds `local` to the
// router's DOMAINS.

/// `(method, path)` for each route outside `/api/projects/{project}` anywhere in src, `.route("…", …)` by `.route("…", …)`.
fn routes_outside_projects() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, files);
            } else if path.extension().is_some_and(|e| e == "rs") && !path.to_string_lossy().ends_with("_tests.rs") {
                files.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let mut routes = Vec::new();
    for file in files {
        for line in std::fs::read_to_string(&file).unwrap().lines() {
            for call in line.split(".route(").skip(1) {
                let Some(said) = call.trim_start().strip_prefix('"') else { continue };
                let Some(end) = said.find('"') else { continue };
                let (path, methods) = (&said[..end], &said[end..]);
                if !path.starts_with('/') || path.starts_with("/api/projects/{project}") {
                    continue;
                }
                for method in ["get", "post", "put", "patch", "delete"] {
                    let called = methods
                        .match_indices(&format!("{method}("))
                        .any(|(at, _)| at == 0 || !methods.as_bytes()[at - 1].is_ascii_alphanumeric() && methods.as_bytes()[at - 1] != b'_');
                    if called {
                        routes.push((method.to_uppercase(), path.to_string()));
                    }
                }
            }
        }
    }
    routes.sort();
    routes.dedup();
    routes
}

#[test]
fn every_route_outside_a_project_says_how_its_held() {
    let census: Vec<Value> = serde_json::from_str(include_str!("../../routes-outside-projects.json")).unwrap();
    let mut listed: Vec<(String, String)> =
        census.iter().map(|e| (e["method"].as_str().unwrap().to_string(), e["path"].as_str().unwrap().to_string())).collect();
    listed.sort();
    let routes = routes_outside_projects();
    let missing: Vec<_> = routes.iter().filter(|r| !listed.contains(r)).collect();
    assert!(missing.is_empty(), "say how each is held in api/routes-outside-projects.json: {missing:?}");
    let gone: Vec<_> = listed.iter().filter(|r| !routes.contains(r)).collect();
    assert!(gone.is_empty(), "no longer routes, so take them out of api/routes-outside-projects.json: {gone:?}");
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in &census {
        let at = format!("{} {}", entry["method"].as_str().unwrap_or_default(), entry["path"].as_str().unwrap_or_default());
        let has = |key: &str| entry[key].as_str().is_some_and(|v| !v.is_empty());
        match entry["held"].as_str().unwrap_or_default() {
            "workspace" | "person" | "owner" => {
                let test = entry["test"].as_str().unwrap_or_else(|| panic!("{at}: name the test that proves it"));
                let (file, name) = test.split_once("::").unwrap_or_else(|| panic!("{at}: `file::test`, not {test}"));
                let source = std::fs::read_to_string(src.join(file)).unwrap_or_else(|_| panic!("{at}: no src/{file}"));
                assert!(source.contains(&format!("fn {name}(")), "{at}: no test {name} in src/{file}");
                if entry["held"] == "person" {
                    assert!(has("why"), "{at}: say whose it is");
                }
            }
            "server" => assert!(has("why"), "{at}: say why it's the same for everyone"),
            "link" => assert!(has("issue") && has("why"), "{at}: name its issue and why"),
            "local" => {}
            held => panic!("{at}: held {held:?} is none of workspace, person, owner, server, link or local"),
        }
    }
}

// A board a member isn't on, inside their own workspace (ORR-985): a 404 in every route of it, its lists and feeds, as
// decision-people-and-claims says. Quarry is in `default` with ana not on it; bo is.

/// The team, with Quarry in `default`: bo on its board, ana not. Its id.
async fn a_board_ana_isnt_on(api: &TestApi) -> String {
    api.team().await;
    let quarry = api.project("Quarry").await;
    api.on_board(&quarry, &["bo"]).await;
    quarry
}

#[tokio::test]
async fn no_route_of_a_board_reads_or_writes_for_a_member_off_it() {
    let api = TestApi::new().await;
    let quarry = a_board_ana_isnt_on(&api).await;
    let login = api.login("ana").await;
    let held = format!("No project {quarry}");
    let mut leaks = Vec::new();
    for (method, route) in project_routes() {
        let path = filled(&route, &quarry);
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
    assert!(leaks.is_empty(), "reached a board ana isn't on:\n{}", leaks.join("\n"));
    // bo, on it, and the owner, on every board, aren't held: the 404s above are the board's.
    for person in ["bo", "sam"] {
        let read = api.signed(api.get(&format!("/api/projects/{quarry}/issues")), person).await.send().await;
        assert_eq!(read.status, 200, "{person}: {}", read.body);
    }
}

#[tokio::test]
async fn a_members_lists_and_feeds_keep_to_the_boards_theyre_on() {
    let api = TestApi::new().await;
    let quarry = a_board_ana_isnt_on(&api).await;
    let primes = api.project("Primes").await;
    api.on_board(&primes, &["ana"]).await;
    api.issue(&quarry, json!({"title": "Blast"})).await;
    api.issue(&primes, json!({"title": "Sieve"})).await;
    assert_eq!(ids(&as_person(&api, "/api/projects", "ana").await), std::slice::from_ref(&primes));
    let mut owners = ids(&as_person(&api, "/api/projects", "sam").await);
    owners.sort();
    assert_eq!(owners, [primes.clone(), quarry.clone()]);
    let feed = projects_of(&as_person(&api, "/api/changes", "ana").await["changes"]);
    assert!(feed.contains(&primes) && !feed.contains(&quarry), "{feed:?}");
    // Her agent key is held alike.
    let read = with_agent_key(&api, api.get(&format!("/api/projects/{quarry}/issues")), "ana", None).await.send().await;
    assert_eq!(read.status, 404, "{}", read.body);
}

#[tokio::test]
async fn an_mcp_tool_reaches_only_the_boards_a_member_is_on() {
    let api = TestApi::new().await;
    let quarry = a_board_ana_isnt_on(&api).await;
    let issue = api.issue(&quarry, json!({"title": "Blast"})).await;
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "issue", "arguments": {"id": issue}}});
    let anas = with_agent_key(&api, api.post("/mcp", body.clone()), "ana", Some("default")).await.send().await;
    assert_eq!(anas.body["result"]["isError"], true, "{}", anas.body);
    let bos = with_agent_key(&api, api.post("/mcp", body), "bo", Some("default")).await.send().await;
    assert_ne!(bos.body["result"]["isError"], true, "{}", bos.body);
}

#[tokio::test]
async fn a_workspaces_owner_sees_every_board_in_it() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = api.acme(&[]).await;
    api.run("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES ('acme', 'ana', 'owner', ?)", &["2026-11-01T00:00:00.000Z"]).await;
    let read = api.signed(api.get(&format!("/api/projects/{rockets}/issues")), "ana").await.send().await;
    assert_eq!(read.status, 200, "Acme is ana's, so its boards are: {}", read.body);
}
