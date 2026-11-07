// The tests of routes/changes.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{TestApi, TOKEN};
use crate::App;
use axum::body::Body;
use axum::http::Request;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

/// An outbox row, as a write's transaction puts one in; its id.
async fn change(api: &TestApi, kind: &str, project: Option<&str>, payload: Option<&str>, untrusted: bool, created_at: &str) -> i64 {
    sqlx::query(&crate::db::sql("INSERT INTO changes (kind, project, subject, actor, owner, session, untrusted, payload, created_at) VALUES (?, ?, 'PRI-1', 'claude', 0, 's1', ?, ?, ?)"))
        .bind(kind)
        .bind(project.map(str::to_owned))
        .bind(i32::from(untrusted))
        .bind(payload.map(str::to_owned))
        .bind(created_at)
        .execute(&api.app.pool)
        .await
        .unwrap();
    sqlx::query("SELECT CAST(MAX(id) AS BIGINT) FROM changes").fetch_one(&api.app.pool).await.map(|r| sqlx::Row::get::<i64, _>(&r, 0)).unwrap()
}

const AT: &str = "2026-11-07T00:00:00.000Z";

/// The first event the stream sends, read off the router directly, as the harness waits for a whole body.
async fn first_event(app: &Arc<App>, after: Option<&str>, last_event_id: Option<&str>) -> (u16, Option<String>, String) {
    let mut request = Request::builder()
        .uri(after.map_or("/api/changes".into(), |a| format!("/api/changes?after={a}")))
        .header("orrery-api-token", TOKEN)
        .header("orrery-database", &app.database)
        .header("orrery-came", "loopback")
        .header("accept", "text/event-stream");
    if let Some(id) = last_event_id {
        request = request.header("last-event-id", id);
    }
    let response = crate::router(app.clone()).oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    let kind = response.headers().get("content-type").map(|v| v.to_str().unwrap().to_string());
    let mut body = response.into_body().into_data_stream();
    let mut text = String::new();
    while !text.contains("\n\n") {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(bytes))) => text.push_str(&String::from_utf8_lossy(&bytes)),
            _ => break,
        }
    }
    (status, kind, text)
}

#[tokio::test]
async fn an_empty_outbox_reads_as_no_changes_after_nothing() {
    let api = TestApi::new().await;
    let read = api.get("/api/changes").send().await;
    assert_eq!(read.status, 200, "{}", read.body);
    assert_eq!(read.body, json!({"changes": [], "last": 0}));
}

#[tokio::test]
async fn reads_the_rows_oldest_first_with_the_id_to_ask_after_next() {
    let api = TestApi::new().await;
    let first = change(&api, "project.changed", Some("primes"), None, false, AT).await;
    let second = change(&api, "issue.status", Some("primes"), Some(r#"{"from":"todo","to":"done","person":"ada"}"#), true, AT).await;
    let read = api.get("/api/changes").send().await;
    assert_eq!(read.body["last"], second);
    let changes = read.body["changes"].as_array().unwrap();
    assert_eq!(changes.iter().map(|c| c["id"].as_i64().unwrap()).collect::<Vec<_>>(), [first, second]);
    assert_eq!(
        changes[1],
        json!({"id": second, "kind": "issue.status", "owner": false, "created_at": AT, "project": "primes", "subject": "PRI-1", "actor": "claude", "session": "s1", "untrusted": true, "payload": {"from": "todo", "to": "done", "person": "ada"}})
    );
    assert!(changes[0].get("untrusted").is_none() && changes[0].get("payload").is_none() && changes[0].get("cause").is_none(), "{}", changes[0]);
    // After the last, nothing new: `last` stays where it was.
    let after = api.get(&format!("/api/changes?after={second}")).send().await;
    assert_eq!(after.body, json!({"changes": [], "last": second}));
    let after_first = api.get(&format!("/api/changes?after={first}")).send().await;
    assert_eq!(after_first.body["changes"].as_array().unwrap().len(), 1);
    // An empty `after` is the start.
    assert_eq!(api.get("/api/changes?after=").send().await.body["changes"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn reads_five_hundred_rows_at_a_time() {
    let api = TestApi::new().await;
    for _ in 0..501 {
        change(&api, "settings", None, None, false, AT).await;
    }
    let page = api.get("/api/changes").send().await;
    assert_eq!(page.body["changes"].as_array().unwrap().len(), 500);
    let next = api.get(&format!("/api/changes?after={}", page.body["last"])).send().await;
    assert_eq!(next.body["changes"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_cursor_whose_row_isnt_kept_is_a_gap_carrying_on_from_the_newest() {
    let api = TestApi::new().await;
    let first = change(&api, "settings", None, None, false, AT).await;
    let newest = change(&api, "epics", None, None, false, AT).await;
    sqlx::query(&crate::db::sql("DELETE FROM changes WHERE id = ?")).bind(first).execute(&api.app.pool).await.unwrap();
    let gap = api.get(&format!("/api/changes?after={first}")).send().await;
    assert_eq!(gap.body, json!({"changes": [], "last": newest, "gap": true}));
    let elsewhere = api.get("/api/changes?after=99999").send().await;
    assert_eq!(elsewhere.body["gap"], true);
}

#[tokio::test]
async fn after_is_a_whole_number() {
    let api = TestApi::new().await;
    for after in ["abc", "-1", "1.5", "1e3"] {
        let refused = api.get(&format!("/api/changes?after={after}")).send().await;
        assert_eq!(refused.status, 400, "{after}: {}", refused.body);
    }
    assert_eq!(api.get("/api/changes?after=%201%20").send().await.status, 200, "spaces around it are fine");
}

#[tokio::test]
async fn the_feed_answers_only_the_router_in_front() {
    let api = TestApi::new().await;
    change(&api, "settings", None, None, false, AT).await;
    assert_eq!(api.get("/api/changes").without("orrery-api-token").send().await.status, 401);
    assert_eq!(api.get("/api/changes").header("orrery-database", "another").send().await.status, 421);
}

#[tokio::test]
async fn streams_the_rows_as_events_carrying_their_ids() {
    let api = TestApi::new().await;
    let first = change(&api, "project.changed", Some("primes"), None, false, AT).await;
    let (status, kind, text) = first_event(&api.app, None, None).await;
    assert_eq!(status, 200);
    assert_eq!(kind.as_deref(), Some("text/event-stream"));
    assert!(text.contains(&format!("id: {first}\n")), "{text}");
    let data = text.lines().find_map(|l| l.strip_prefix("data: ")).expect("a data line");
    let sent: Value = serde_json::from_str(data).unwrap();
    assert_eq!((sent["id"].as_i64(), sent["kind"].as_str()), (Some(first), Some("project.changed")));
}

#[tokio::test]
async fn a_reconnecting_stream_carries_on_from_its_last_event_id() {
    let api = TestApi::new().await;
    let first = change(&api, "settings", None, None, false, AT).await;
    let second = change(&api, "epics", None, None, false, AT).await;
    // Last-Event-ID stands for `after`, and wins over it.
    let (_, _, text) = first_event(&api.app, Some("0"), Some(&first.to_string())).await;
    assert!(text.contains(&format!("id: {second}\n")), "{text}");
}

#[tokio::test]
async fn a_stream_from_a_cursor_not_kept_starts_with_a_gap() {
    let api = TestApi::new().await;
    let newest = change(&api, "settings", None, None, false, AT).await;
    let (_, _, text) = first_event(&api.app, Some("4242"), None).await;
    assert!(text.contains("event: gap\n"), "{text}");
    assert!(text.contains(&json!({"last": newest}).to_string()), "{text}");
}

#[tokio::test]
async fn a_stream_with_a_bad_cursor_is_refused() {
    let api = TestApi::new().await;
    let (status, _, _) = first_event(&api.app, None, Some("nope")).await;
    assert_eq!(status, 400);
    let (status, _, _) = first_event(&api.app, Some("-3"), None).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn a_stream_sends_a_write_committed_while_it_waits() {
    let api = TestApi::new().await;
    let write = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        sqlx::query(&crate::db::sql("INSERT INTO changes (kind, owner, untrusted, created_at) VALUES ('settings', 1, 0, ?)"))
            .bind(AT)
            .execute(&api.app.pool)
            .await
            .unwrap();
        crate::changes::wake();
    };
    let started = std::time::Instant::now();
    let ((_, _, text), ()) = tokio::join!(first_event(&api.app, None, None), write);
    // Woken, it sends at once rather than on its next look a second on.
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    assert!(text.contains("\"kind\":\"settings\""), "{text}");
}
