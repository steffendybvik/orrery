// Nobody sees another person's entries (ORR-1352): every route the API serves and every tool `/mcp` lists, called by
// ana, shows nothing of bo's workspace, changes nothing of it, and answers bo's ids as it answers ids that don't
// exist, so not even an error says one is there (ORR-1350).
//
// bo and cy keep a workspace, Acme, with a row of every kind in it, each named with MARK. ana is in `default` alone.
// The routes are read from src, as seen_tests.rs reads them, and the tools from api/mcp-tools.json, so a new one is
// swept without being added here.
use crate::testing::{random_id, Reply, Req, TestApi};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Path parts whose ids nobody can guess, so a refusal to bo's may come before the body is read where one to an id that
/// doesn't exist comes after: what's said still gives nothing of bo's away, and nothing of bo's changes. A chat's id is
/// its launch's, 48 random bits (`hold` in web/server/utils/launches.ts).
const UNGUESSABLE: &[&str] = &["{chat}"];

/// In the name or text of every row of bo's: seen anywhere in ana's answers, it's a leak.
const MARK: &str = "Zephyrine";

/// bo's world in Acme: each path part's real id there, and one of the same kind that doesn't exist.
struct Theirs {
    real: BTreeMap<&'static str, String>,
    ghost: BTreeMap<&'static str, String>,
}

impl Theirs {
    /// The value for `part` (`{issue}`) in a route under `route`, real or a ghost.
    fn fill(&self, route: &str, real: bool) -> String {
        let pick = if real { &self.real } else { &self.ghost };
        route
            .split('/')
            .map(|part| {
                let Some(name) = part.strip_prefix('{').and_then(|p| p.strip_suffix('}')) else { return part.to_string() };
                // An epic's comment and an issue's are kept apart.
                let key = if name == "comment" && route.starts_with("/api/epics") { "epic_comment" } else { name };
                pick.get(key).cloned().unwrap_or_else(|| "1".to_string())
            })
            .collect::<Vec<_>>()
            .join("/")
    }

    /// `text` with each of bo's ids (`real`) or each ghost named for its kind, and every number as `N`, so an answer to
    /// bo's ids can be compared with one to ids that don't exist.
    fn plain(&self, text: &str, real: bool) -> String {
        let ids = if real { &self.real } else { &self.ghost };
        let mut pairs: Vec<(&&str, &String)> = ids.iter().filter(|(_, v)| v.parse::<i64>().is_err()).collect();
        pairs.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
        let named = pairs.into_iter().fold(text.to_string(), |text, (k, v)| text.replace(v.as_str(), &format!("<{k}>")));
        regex::Regex::new("[0-9]+").unwrap().replace_all(&named, "N").into_owned()
    }

    /// The ids of bo's that are long enough to look for in an answer without matching something else.
    fn telling(&self) -> Vec<&String> {
        self.real.values().filter(|v| v.len() >= 5).collect()
    }
}

/// As bo, signed in, in Acme: the reply, which has to be a success.
async fn as_bo(api: &TestApi, req: Req) -> Reply {
    let reply = api.signed(req.header("orrery-workspace", "acme").header("orrery-sent-origin", "http://localhost"), "bo").await.send().await;
    assert!(reply.status.is_success(), "seeding: {} {}", reply.status, reply.body);
    reply
}

fn id_of(reply: &Reply) -> String {
    match &reply.body["id"] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        other => panic!("no id in {other}: {}", reply.body),
    }
}

/// The team, with ana in `default` alone, and bo and cy in Acme with a row of every kind there.
async fn bos_world(api: &TestApi) -> Theirs {
    api.team().await;
    let primes = api.project("Primes").await;
    api.on_board(&primes, &["ana", "bo"]).await;
    let rockets = api.acme(&["bo"]).await;
    let stamp = "2026-11-20T10:00:00.000Z";
    api.run("UPDATE workspaces SET name = ? WHERE id = 'acme'", &[&format!("Acme {MARK}")]).await;
    api.run("UPDATE projects SET name = ? WHERE id = ?", &[&format!("Rockets {MARK}"), &rockets]).await;
    // cy is in Acme alone: nobody in `default` knows of them.
    api.run("INSERT INTO people (id, name, role, created_at) VALUES ('cyzephyr', ?, 'member', ?)", &[&format!("Cy {MARK}"), stamp]).await;
    api.run("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES ('acme', 'cyzephyr', 'member', ?)", &[stamp]).await;
    api.on_board(&rockets, &["cyzephyr"]).await;

    let at = |path: &str| format!("/api/projects/{rockets}{path}");
    let issue = id_of(&as_bo(api, api.post(&at("/issues"), json!({"title": format!("Fuel {MARK}"), "notes": MARK}))).await);
    let comment = id_of(&as_bo(api, api.post(&at(&format!("/issues/{issue}/comments")), json!({"body": format!("Seen {MARK}")}))).await);
    let doc = id_of(&as_bo(api, api.post(&at("/docs"), json!({"title": format!("Plan {MARK}"), "body": MARK}))).await);
    let milestone = id_of(&as_bo(api, api.post(&at("/milestones"), json!({"title": format!("Liftoff {MARK}")}))).await);
    api.run("UPDATE projects SET release_mode = 'own' WHERE id = ?", &[&rockets]).await;
    as_bo(api, api.post(&at("/releases"), json!({"version": "7.7.7", "notes": MARK}))).await;
    let epic = id_of(&as_bo(api, api.post("/api/epics", json!({"title": format!("Launch {MARK}")}))).await);
    let epic_comment = id_of(&as_bo(api, api.post(&format!("/api/epics/{epic}/comments"), json!({"body": format!("Go {MARK}")}))).await);
    let preset = id_of(&as_bo(api, api.post("/api/presets", json!({"name": format!("Careful {MARK}"), "text": MARK}))).await);
    let status = id_of(&as_bo(api, api.post("/api/statuses", json!({"name": format!("Zephyr {MARK}"), "kind": "started"}))).await);
    let schedule = id_of(&as_bo(api, api.post("/api/schedules", json!({"projects": [rockets], "title": format!("Tidy {MARK}"), "cron": "0 9 * * 1"}))).await);
    let mut png = vec![];
    image::codecs::png::PngEncoder::new(&mut png).write_image(&[200u8; 3 * 4 * 4], 4, 4, image::ExtendedColorType::Rgb8).unwrap();
    use image::ImageEncoder;
    let upload = id_of(&as_bo(api, api.post("/api/uploads", json!({"data": STANDARD.encode(&png), "name": format!("{MARK}.png")}))).await);
    let key = as_bo(api, api.post("/api/keys", json!({"kind": "agent", "name": format!("Rig {MARK}"), "workspace": "acme"}))).await;
    let key = id_of(&key);
    let login: String = api.login("bo").await;
    let login_id: String = sqlx::query_scalar(crate::db::sql("SELECT id FROM logins WHERE person = 'bo' ORDER BY created_at DESC LIMIT 1"))
        .fetch_one(&api.app.pool)
        .await
        .unwrap();
    drop(login);
    let secret = "ZEPHYRINE_TOKEN";
    api.run(
        "INSERT INTO secrets (name, value, last4, hosts, projects, created_by, owned, created_at, updated_at, workspace) \
         VALUES (?, 'sealed', 'wxyz', 'zephyrine.example', ?, 'bo', 1, ?, ?, 'acme')",
        &[secret, &rockets, stamp, stamp],
    )
    .await;
    api.run(
        "INSERT INTO events (level, kind, project, message, count, first_seen, last_seen) VALUES ('error', 'note', ?, ?, 1, ?, ?)",
        &[&rockets, &format!("Broke {MARK}"), stamp, stamp],
    )
    .await;
    let event: String = sqlx::query_scalar::<_, i64>(crate::db::sql("SELECT max(id) FROM events")).fetch_one(&api.app.pool).await.unwrap().to_string();
    let chat = format!("zephyrchat{}", &random_id()[..6]);
    let kept = api
        .put(
            &format!("/api/chats/{chat}"),
            json!({"id": chat, "project": rockets, "started_at": stamp, "messages": [{"from": "owner", "text": MARK, "images": []}], "model": "sonnet"}),
        )
        .send()
        .await;
    assert!(kept.status.is_success(), "seeding the chat: {}", kept.body);
    let session = format!("zephyrsession{}", &random_id()[..6]);
    api.record_session(&session, "untrusted", Some(&rockets)).await;
    api.run("UPDATE session_records SET workspace = 'acme' WHERE session = ?", &[&session]).await;
    // A proposal by bo's agent: the bell's.
    as_bo(api, api.post(&at("/issues"), json!({"title": format!("Maybe {MARK}"), "proposal": "pending"})).by_agent("claude")).await;

    let real: BTreeMap<&'static str, String> = [
        ("project", rockets.clone()),
        ("issue", issue.clone()),
        ("comment", comment),
        ("doc", doc),
        ("milestone", milestone),
        ("release", "7.7.7".to_string()),
        ("epic", epic),
        ("epic_comment", epic_comment),
        ("preset", preset),
        ("status", status),
        ("schedule", schedule.clone()),
        ("across", schedule),
        ("upload", upload),
        ("key", key),
        ("login", login_id),
        ("name", secret.to_string()),
        ("event", event),
        ("chat", chat),
        ("session", session),
        ("person", "cyzephyr".to_string()),
        ("workspace", "acme".to_string()),
    ]
    .into();
    // A ghost has the shape of the real id with nothing behind it: digits made larger, text changed at its end.
    let ghost = real
        .iter()
        .map(|(k, v)| {
            let ghost = match v.parse::<i64>() {
                Ok(n) => (n + 90_000).to_string(),
                Err(_) if *k == "issue" => format!("{v}0999"),
                Err(_) if *k == "release" => "9.9.9".to_string(),
                Err(_) if *k == "upload" => "f".repeat(v.len()),
                Err(_) => format!("{v}q"),
            };
            (*k, ghost)
        })
        .collect();
    Theirs { real, ghost }
}

/// `(method, path)` for every route in src, `/api/projects/{project}/…` included, as seen_tests.rs reads them.
fn every_route() -> Vec<(String, String)> {
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
                let call = call.trim_start();
                let (route, methods) = if let Some(methods) = call.strip_prefix("P,") {
                    ("/api/projects/{project}".to_string(), methods)
                } else {
                    let Some(open) = call.find('"') else { continue };
                    if open > 12 {
                        continue;
                    }
                    let Some(len) = call[open + 1..].find('"') else { continue };
                    let said = &call[open + 1..open + 1 + len];
                    (said.replace("{P}", "/api/projects/{project}").replace("{{", "{").replace("}}", "}"), &call[open + 1 + len..])
                };
                if !route.starts_with('/') {
                    continue;
                }
                for method in ["get", "post", "put", "patch", "delete"] {
                    let called = methods
                        .match_indices(&format!("{method}("))
                        .any(|(at, _)| at == 0 || !methods.as_bytes()[at - 1].is_ascii_alphanumeric() && methods.as_bytes()[at - 1] != b'_');
                    if called {
                        routes.push((method.to_uppercase(), route.clone()));
                    }
                }
            }
        }
    }
    routes.sort();
    routes.dedup();
    routes
}

/// What gives bo's world away in `text`: MARK, or one of bo's ids.
fn gives_away(theirs: &Theirs, text: &str) -> Option<String> {
    if text.contains(MARK) {
        return Some(MARK.to_string());
    }
    theirs.telling().into_iter().find(|id| text.contains(id.as_str())).cloned()
}

/// Everything of bo's as bo reads it, to see that nothing ana sent changed it.
async fn bos_view(api: &TestApi, theirs: &Theirs) -> String {
    let rockets = &theirs.real["project"];
    let epic = &theirs.real["epic"];
    let mut view = String::new();
    for path in [
        format!("/api/projects/{rockets}/export"),
        format!("/api/projects/{rockets}/issues/{}/comments", theirs.real["issue"]),
        "/api/epics".to_string(),
        format!("/api/epics/{epic}/comments"),
        "/api/presets".to_string(),
        "/api/statuses".to_string(),
        "/api/schedules".to_string(),
        "/api/secrets".to_string(),
        "/api/uploads".to_string(),
        "/api/settings".to_string(),
        "/api/workspaces".to_string(),
        "/api/people".to_string(),
        format!("/api/chats/{}", theirs.real["chat"]),
    ] {
        let reply = api.get(&path).header("orrery-workspace", "acme").send().await;
        let mut body = reply.body.clone();
        // When it was read isn't part of what's kept.
        if let Some(o) = body.as_object_mut() {
            o.remove("exported_at");
        }
        view.push_str(&format!("{path}: {} {body}\n", reply.status));
    }
    view
}

#[test]
fn every_route_is_found() {
    let routes = every_route();
    assert!(routes.len() > 200, "{}", routes.len());
    for expected in [("GET", "/api/projects/{project}"), ("GET", "/api/chats"), ("POST", "/mcp"), ("DELETE", "/api/projects/{project}/docs/{doc}")] {
        assert!(routes.iter().any(|(m, r)| (m.as_str(), r.as_str()) == expected), "{expected:?} not found");
    }
}

/// Each actor ana can be, through the router: her login in a browser, her agent key, and her key's session.
async fn as_ana(api: &TestApi, req: Req, actor: &str) -> Req {
    let req = req.header("orrery-came", "loopback").header("orrery-login-ways", "on").header("orrery-sent-origin", "http://localhost");
    match actor {
        "login" => req.signed_in(&api.login("ana").await),
        "key" => {
            let key = api.key("ana", "agent").await;
            api.run("UPDATE keys SET workspace = 'default' WHERE hash = ?", &[&key]).await;
            req.header("orrery-key", &key).header("orrery-session", "ana-session")
        }
        other => panic!("no actor {other}"),
    }
}

/// A route ana calls with bo's ids: it answers as it does with ids that don't exist, and gives nothing of bo's away.
#[tokio::test]
async fn no_route_shows_or_changes_another_workspaces_entries() {
    let api = TestApi::new().await;
    let theirs = bos_world(&api).await;
    let before = bos_view(&api, &theirs).await;
    let mut leaks = Vec::new();
    for actor in ["login", "key"] {
        for (method, route) in every_route() {
            let send = |real: bool| {
                let api = &api;
                let path = theirs.fill(&route, real);
                let method = method.clone();
                async move { as_ana(api, api.request(method.parse().unwrap(), &path).json(json!({})), actor).await.send().await }
            };
            // The ghost first: a write that wrongly reaches bo's row then can't change what the ghost answers.
            let ghost = send(false).await;
            let real = send(true).await;
            let said = real.body.to_string();
            if said.contains(MARK) {
                leaks.push(format!("{actor}: {method} {route} gives away {MARK}: {} {said}", real.status));
            } else if UNGUESSABLE.iter().any(|part| route.contains(part)) && real.status == 404 {
                // Refused as not there, before its body was read.
            } else if real.status != ghost.status {
                leaks.push(format!("{actor}: {method} {route}: {} for bo's, {} for none: {said}", real.status, ghost.status));
            } else if (!real.status.is_success() || method == "GET" && route.contains('{'))
                && theirs.plain(&said, true) != theirs.plain(&ghost.body.to_string(), false)
            {
                leaks.push(format!("{actor}: {method} {route} answers bo's otherwise: {said} vs {}", ghost.body));
            }
        }
    }
    assert!(leaks.is_empty(), "ana reached bo's workspace:\n{}", leaks.join("\n"));
    unchanged(&before, &bos_view(&api, &theirs).await, "something ana sent");
}

/// Every tool `/mcp` lists, for each kind of session, called by ana's agent key with bo's ids in each argument that
/// takes one: none of bo's rows, ids or names come back, and bo's workspace is as it was.
#[tokio::test]
async fn no_mcp_tool_shows_or_changes_another_workspaces_entries() {
    let api = TestApi::new().await;
    let theirs = bos_world(&api).await;
    let before = bos_view(&api, &theirs).await;
    let key = api.key("ana", "agent").await;
    api.run("UPDATE keys SET workspace = 'default' WHERE hash = ?", &[&key]).await;
    let mcp = |body: Value, kind: &str, session: &str| {
        api.post("/mcp", body)
            .header("orrery-came", "loopback")
            .header("orrery-login-ways", "on")
            .header("orrery-key", &key)
            .header("orrery-actor-kind", kind)
            .header("orrery-launch", "c1")
            .header("mcp-session-id", session)
    };
    let started = mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}), "work", "")
        .without("mcp-session-id")
        .send()
        .await;
    let session = started.header("mcp-session-id").expect("a session").to_string();
    for group in ["schedules", "secrets", "debug", "review", "epics"] {
        let call = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "more_tools", "arguments": {"group": group}}});
        mcp(call, "work", &session).send().await;
    }
    // What each argument is given, by its name: bo's id (or its ghost) where it takes one, else something plain.
    let argument = |name: &str, schema: &Value, ids: &BTreeMap<&'static str, String>| -> Value {
        let key = match name {
            "id" | "issue" | "parent" => Some("issue"),
            "project" => Some("project"),
            "doc" => Some("doc"),
            "milestone" => Some("milestone"),
            "release" | "version" => Some("release"),
            "epic" => Some("epic"),
            "name" | "secret" => Some("name"),
            "status" | "column" => Some("status"),
            "upload" | "image" => Some("upload"),
            "chat" => Some("chat"),
            "session" => Some("session"),
            "event" => Some("event"),
            "preset" => Some("preset"),
            _ => None,
        };
        let kind = schema["type"].as_str().or_else(|| schema["type"][0].as_str()).unwrap_or("string");
        match (key.map(|k| &ids[k]), kind) {
            (Some(id), "number" | "integer") => json!(id.parse::<i64>().unwrap_or(1)),
            (Some(id), _) => json!(id),
            (None, "number" | "integer") => json!(1),
            (None, "boolean") => json!(false),
            (None, "array") => json!([]),
            (None, "object") => json!({}),
            (None, _) => schema["enum"].get(0).cloned().unwrap_or(json!("x")),
        }
    };
    let text = |reply: &Reply| reply.body["result"].to_string();
    let mut leaks = Vec::new();
    let mut called = 0;
    for kind in ["work", "chat", "untrusted"] {
        let listed = mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}), kind, &session).send().await;
        if let Some(found) = gives_away(&theirs, &listed.body.to_string()) {
            leaks.push(format!("{kind}: tools/list gives away {found}"));
        }
        for tool in listed.body["result"]["tools"].as_array().expect("a tool list") {
            let name = tool["name"].as_str().unwrap();
            let properties = tool["inputSchema"]["properties"].as_object().cloned().unwrap_or_default();
            let args = |ids| Value::Object(properties.iter().map(|(k, s)| (k.clone(), argument(k, s, ids))).collect());
            let call = |args: Value| json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}});
            // With nothing, its own project and lists: nothing of bo's.
            let plain = mcp(call(json!({})), kind, &session).send().await;
            if let Some(found) = gives_away(&theirs, &text(&plain)) {
                leaks.push(format!("{kind}: {name}() gives away {found}: {}", text(&plain)));
            }
            // With bo's ids, as with ids that don't exist (the ghost first, so a wrong write can't change its answer).
            let ghost = mcp(call(args(&theirs.ghost)), kind, &session).send().await;
            let real = mcp(call(args(&theirs.real)), kind, &session).send().await;
            called += 3;
            let (ghost_said, real_said) = (theirs.plain(&text(&ghost), false), theirs.plain(&text(&real), true));
            if text(&real).contains(MARK) {
                leaks.push(format!("{kind}: {name} with bo's ids gives away {MARK}: {}", text(&real)));
            } else if ghost.body["result"]["isError"] != real.body["result"]["isError"] || (real.body["result"]["isError"] == true && ghost_said != real_said) {
                leaks.push(format!("{kind}: {name} answers bo's ids otherwise: {real_said} vs {ghost_said}"));
            }
        }
    }
    assert!(called > 60, "only {called} calls: are the tools listed?");
    assert!(leaks.is_empty(), "ana's tools reached bo's workspace:\n{}", leaks.join("\n"));
    unchanged(&before, &bos_view(&api, &theirs).await, "a tool ana called");
}

/// Fails with where bo's view changed, line by line, each a little either side of where it first differs.
fn unchanged(before: &str, after: &str, what: &str) {
    let changed: Vec<String> = before
        .lines()
        .zip(after.lines())
        .filter(|(b, a)| b != a)
        .map(|(b, a)| {
            let at = b.bytes().zip(a.bytes()).take_while(|(x, y)| x == y).count();
            let around = |s: &str| s.get(at.saturating_sub(120)..(at + 120).min(s.len())).unwrap_or(s).to_string();
            format!("{}\n  was: …{}…\n  now: …{}…", b.split(':').next().unwrap_or(""), around(b), around(a))
        })
        .collect();
    assert!(changed.is_empty(), "{what} changed bo's workspace:\n{}", changed.join("\n"));
}
