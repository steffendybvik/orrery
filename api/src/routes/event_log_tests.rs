// The tests of routes/event_log.rs (ORR-1088), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};

/// A line as the Nuxt server's event log writes one, last seen at `at`; its id.
async fn line(api: &TestApi, level: &str, kind: &str, project: Option<&str>, message: &str, at: &str) -> i64 {
    match project {
        Some(project) => {
            api.run(
                "INSERT INTO events (level, kind, project, message, count, first_seen, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?)",
                &[level, kind, project, message, at, at],
            )
            .await
        }
        None => {
            api.run("INSERT INTO events (level, kind, message, count, first_seen, last_seen) VALUES (?, ?, ?, 1, ?, ?)", &[level, kind, message, at, at]).await
        }
    }
    let all = api.get("/api/events/log?limit=1000").send().await;
    all.body.as_array().unwrap().iter().map(|e| e["id"].as_i64().unwrap()).max().unwrap()
}

fn kinds(reply: &Value) -> Vec<&str> {
    reply.as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn the_log_reads_newest_first_and_filters_as_the_route_did() {
    let api = TestApi::new().await;
    line(&api, "error", "server.error", None, "Boom", "2026-11-10T10:00:00.000Z").await;
    line(&api, "info", "session.started", Some("primes"), "Started", "2026-11-10T10:01:00.000Z").await;
    line(&api, "warn", "session_x.odd", Some("primes"), "Odd", "2026-11-10T10:02:00.000Z").await;
    api.run(
        "INSERT INTO events (level, kind, project, subject, message, count, first_seen, last_seen) VALUES ('info', 'issue.status', 'primes', 'PRI-1', 'Moved', 1, ?, ?)",
        &["2026-11-10T10:03:00.000Z", "2026-11-10T10:03:00.000Z"],
    )
    .await;
    let all = api.get("/api/events/log").send().await;
    assert_eq!(all.status, 200, "{}", all.body);
    assert_eq!(kinds(&all.body), ["issue.status", "session_x.odd", "session.started", "server.error"]);
    assert_eq!(kinds(&api.get("/api/events/log?level=error,warn").send().await.body), ["session_x.odd", "server.error"]);
    // A name is every kind under it, and `_` in it is only itself.
    assert_eq!(kinds(&api.get("/api/events/log?kind=session").send().await.body), ["session.started"]);
    assert_eq!(kinds(&api.get("/api/events/log?kind=server.error").send().await.body), ["server.error"]);
    assert_eq!(kinds(&api.get("/api/events/log?project=primes&subject=PRI-1").send().await.body), ["issue.status"]);
    assert_eq!(kinds(&api.get("/api/events/log?since=2026-11-10T10:01:30Z").send().await.body), ["issue.status", "session_x.odd"]);
    assert_eq!(kinds(&api.get("/api/events/log?limit=2").send().await.body), ["issue.status", "session_x.odd"]);
    let wrong = api.get("/api/events/log?level=error,loud").send().await;
    assert_eq!((wrong.status.as_u16(), wrong.body["message"].as_str()), (400, Some("\"level\" has \"loud\"; use error, warn, info")));
    assert_eq!(api.get("/api/events/log?since=soon").send().await.status, 400);
    let moved = &api.get("/api/events/log?subject=PRI-1").send().await.body[0];
    assert_eq!(
        moved,
        &json!({"id": moved["id"], "level": "info", "kind": "issue.status", "project": "primes", "subject": "PRI-1", "message": "Moved", "count": 1,
            "first_seen": "2026-11-10T10:03:00.000Z", "last_seen": "2026-11-10T10:03:00.000Z"})
    );
}

#[tokio::test]
async fn resolving_a_line_resolves_its_repeats_and_tells_each_in_the_outbox() {
    let api = TestApi::new().await;
    let first = line(&api, "error", "server.error", Some("primes"), "Boom", "2026-11-10T10:00:00.000Z").await;
    let again = line(&api, "error", "server.error", Some("primes"), "Boom", "2026-11-10T10:01:00.000Z").await;
    let other = line(&api, "error", "server.error", Some("primes"), "Bang", "2026-11-10T10:02:00.000Z").await;
    let before = api.outbox().await.len();
    let resolved = api.post(&format!("/api/events/log/{first}/resolve"), json!({})).by_agent("claude").send().await;
    assert_eq!(resolved.status, 200, "{}", resolved.body);
    assert_eq!(resolved.body["id"], json!(first));
    assert_eq!(resolved.body["resolved_by"], json!("claude"), "an agent's name is kept");
    assert!(resolved.body["resolved_at"].is_string());
    let open = api.get("/api/events/log?open=1").send().await;
    assert_eq!(open.body.as_array().unwrap().iter().map(|e| e["id"].as_i64().unwrap()).collect::<Vec<_>>(), [other], "the repeat went with it");
    let rows = api.outbox().await;
    let logged: Vec<i64> = rows[before..].iter().filter(|r| r.kind == "event.logged").map(|r| r.payload()["id"].as_i64().unwrap()).collect();
    assert_eq!(logged, [again, first], "the repeats, then the line itself");
    // Resolving it again keeps when and by whom.
    let twice = api.post(&format!("/api/events/log/{first}/resolve"), json!({})).send().await;
    assert_eq!((twice.body["resolved_at"].clone(), twice.body["resolved_by"].clone()), (resolved.body["resolved_at"].clone(), json!("claude")));
}

#[tokio::test]
async fn the_owner_resolving_keeps_no_name_and_a_line_there_isnt_is_404() {
    let api = TestApi::new().await;
    let id = line(&api, "warn", "request.refused", None, "Refused", "2026-11-10T10:00:00.000Z").await;
    let resolved = api.post(&format!("/api/events/log/{id}/resolve"), json!({})).send().await;
    assert_eq!(resolved.status, 200);
    assert!(resolved.body.get("resolved_by").is_none());
    for missing in ["999", "soon"] {
        let reply = api.post(&format!("/api/events/log/{missing}/resolve"), json!({})).send().await;
        assert_eq!((reply.status.as_u16(), reply.body["message"].as_str()), (404, Some(format!("No event {missing}").as_str())));
    }
}

#[tokio::test]
async fn an_untrusted_session_cant_resolve_a_line() {
    let api = TestApi::new().await;
    let id = line(&api, "error", "server.error", None, "Boom", "2026-11-10T10:00:00.000Z").await;
    let refused = api.post(&format!("/api/events/log/{id}/resolve"), json!({})).untrusted().send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(api.get("/api/events/log?open=1").send().await.body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn the_local_app_writes_a_line_and_a_repeat_of_an_open_one_is_no_news() {
    let api = TestApi::new().await;
    let before = api.outbox().await.len();
    let line = json!({"level": "error", "kind": "server.error", "project": "primes", "message": "Boom", "details": {"route": "GET /api/x", "status": 500}});
    let first = api.put("/api/events/log/lines", line.clone()).send().await;
    assert_eq!(first.status, 201, "{}", first.body);
    assert_eq!(first.body["fresh"], json!(true));
    let event = &first.body["event"];
    assert_eq!(
        event,
        &json!({"id": event["id"], "level": "error", "kind": "server.error", "project": "primes", "message": "Boom",
            "details": {"route": "GET /api/x", "status": 500}, "count": 1, "first_seen": event["first_seen"], "last_seen": event["first_seen"]})
    );
    let again = api.put("/api/events/log/lines", line.clone()).send().await;
    assert_eq!(again.body["fresh"], json!(false), "a repeat of an open one is a line, but no news");
    assert_ne!(again.body["event"]["id"], event["id"], "a line of its own");
    // Each goes into the outbox, the fresh one saying so, for open pages' bells.
    let rows = api.outbox().await;
    let logged: Vec<Value> = rows[before..].iter().filter(|r| r.kind == "event.logged").map(|r| r.payload()).collect();
    assert_eq!(logged.len(), 2);
    assert_eq!((logged[0]["id"].clone(), logged[0]["fresh"].clone()), (event["id"].clone(), json!(true)));
    assert_eq!((logged[1]["id"].clone(), logged[1].get("fresh")), (again.body["event"]["id"].clone(), None));
    // Once it's resolved, the next one is news again.
    api.post(&format!("/api/events/log/{}/resolve", event["id"]), json!({})).send().await;
    assert_eq!(api.put("/api/events/log/lines", line).send().await.body["fresh"], json!(true));
}

#[tokio::test]
async fn a_change_to_the_roadmap_is_always_news_and_keeps_its_subject() {
    let api = TestApi::new().await;
    let line = json!({"level": "info", "kind": "issue.status", "project": "primes", "subject": "PRI-1", "message": "claude moved PRI-1: todo → done", "activity": true});
    assert_eq!(api.put("/api/events/log/lines", line.clone()).send().await.body["fresh"], json!(true));
    let again = api.put("/api/events/log/lines", line).send().await;
    assert_eq!(again.body["fresh"], json!(true));
    assert_eq!(again.body["event"]["subject"], json!("PRI-1"));
    assert!(again.body["event"].get("details").is_none(), "no details, none kept");
}

#[tokio::test]
async fn a_line_that_isnt_one_is_refused_and_a_long_message_is_cut() {
    let api = TestApi::new().await;
    for (line, message) in [
        (json!({"level": "loud", "kind": "page.error", "message": "x"}), "\"level\" is \"loud\"; use error, warn, info"),
        (json!({"level": "error", "kind": "Page Error", "message": "x"}), "\"kind\" is \"Page Error\"; use a dotted name, e.g. page.error"),
        (json!({"level": "error", "kind": "page.error", "message": "x", "details": "text"}), "\"details\" is an object"),
    ] {
        let reply = api.put("/api/events/log/lines", line).send().await;
        assert_eq!((reply.status.as_u16(), reply.body["message"].as_str()), (400, Some(message)));
    }
    let long = api.put("/api/events/log/lines", json!({"level": "error", "kind": "page.error", "message": "x".repeat(1500)})).send().await;
    assert_eq!(long.body["event"]["message"].as_str().unwrap().chars().count(), 1000);
    let blank = api.put("/api/events/log/lines", json!({"level": "error", "kind": "page.error", "message": "  "})).send().await;
    assert_eq!(blank.body["event"]["message"], json!("page.error"), "a blank message is its kind");
}

#[tokio::test]
async fn only_the_local_app_writes_a_line_or_prunes() {
    let api = TestApi::new().await;
    let line = json!({"level": "error", "kind": "page.error", "message": "Sent by a page"});
    let refused = api.put("/api/events/log/lines", line).header("orrery-came", "loopback").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(api.post("/api/events/log/prune", json!({})).header("orrery-came", "loopback").send().await.status, 403);
    assert_eq!(api.count("SELECT COUNT(*) FROM events").await, 0);
}

#[tokio::test]
async fn pruning_lets_old_lines_go_and_keeps_the_rest() {
    let api = TestApi::new().await;
    let day = |days: i64| (chrono::Utc::now() - chrono::Duration::days(days)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    line(&api, "info", "session.started", None, "Old info", &day(8)).await;
    line(&api, "info", "session.started", None, "New info", &day(6)).await;
    line(&api, "error", "server.error", None, "Old error", &day(31)).await;
    line(&api, "error", "server.error", None, "Recent error", &day(29)).await;
    let pruned = api.post("/api/events/log/prune", json!({})).send().await;
    assert_eq!((pruned.status.as_u16(), pruned.body["pruned"].clone()), (200, json!(2)), "{}", pruned.body);
    let left: Vec<String> =
        api.get("/api/events/log").send().await.body.as_array().unwrap().iter().map(|e| e["message"].as_str().unwrap().to_string()).collect();
    assert_eq!(left, ["New info", "Recent error"]);
}

/// A line is its workspace's (ORR-1107): its project's, or the one the local app names for a line naming none. Each
/// workspace's log lists and resolves its own lines alone.
#[tokio::test]
async fn each_workspace_keeps_its_own_lines() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = api.acme(&["bo"]).await;
    let write = |line: Value, workspace: Option<&'static str>| {
        let api = &api;
        async move {
            let req = api.put("/api/events/log/lines", line);
            let req = match workspace {
                Some(w) => req.header("orrery-workspace", w),
                None => req,
            };
            let reply = req.send().await;
            assert_eq!(reply.status, 201, "{}", reply.body);
            reply.body["event"]["id"].as_i64().unwrap()
        }
    };
    let launched = write(json!({"level": "info", "kind": "session.started", "project": rockets, "message": "Launched"}), None).await;
    let theirs = write(json!({"level": "warn", "kind": "server.slow", "message": "Slow"}), Some("acme")).await;
    write(json!({"level": "error", "kind": "server.error", "message": "Boom"}), None).await;

    let as_person = |path: &str, person: &'static str, workspace: Option<&'static str>| {
        let api = &api;
        let path = path.to_string();
        async move {
            let req = api.get(&path);
            let req = match workspace {
                Some(w) => req.header("orrery-workspace", w),
                None => req,
            };
            api.signed(req, person).await.send().await
        }
    };
    let acme = as_person("/api/events/log", "bo", Some("acme")).await;
    assert_eq!(kinds(&acme.body), ["server.slow", "session.started"], "{}", acme.body);
    let default = as_person("/api/events/log", "bo", None).await;
    assert_eq!(kinds(&default.body), ["server.error"], "{}", default.body);
    assert_eq!(as_person("/api/events/log", "ana", Some("acme")).await.status, 404);

    let resolve = |id: i64, person: &'static str, workspace: Option<&'static str>| {
        let api = &api;
        async move {
            let req = api.post(&format!("/api/events/log/{id}/resolve"), json!({})).header("orrery-sent-origin", "http://localhost");
            let req = match workspace {
                Some(w) => req.header("orrery-workspace", w),
                None => req,
            };
            api.signed(req, person).await.send().await.status
        }
    };
    assert_eq!(resolve(theirs, "ana", None).await, 404, "from default, Acme's line isn't there");
    assert_eq!(resolve(launched, "bo", Some("acme")).await, 200);
}
