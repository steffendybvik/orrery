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
