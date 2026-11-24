// A session's record (ORR-1171): kept once by the local app, only ever tightened, and carried to a session's new id.
use crate::testing::{from_outside, TestApi};
use serde_json::{json, Value};

async fn keep(api: &TestApi, session: &str, body: Value) -> (u16, Value) {
    let reply = api.put(&format!("/api/session-records/{session}"), body).send().await;
    (reply.status.as_u16(), reply.body)
}

#[tokio::test]
async fn keeps_an_untrusted_session_with_its_project_and_its_workspace() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let (status, record) = keep(&api, "run-1", json!({"kind": "untrusted", "project": primes})).await;
    assert_eq!(status, 200, "{record}");
    assert_eq!(
        (record["session"].as_str(), record["kind"].as_str(), record["project"].as_str(), record["workspace"].as_str()),
        (Some("run-1"), Some("untrusted"), Some(primes.as_str()), Some("default"))
    );
    // Said again, it's as it was.
    let (status, again) = keep(&api, "run-1", json!({"kind": "untrusted", "project": primes})).await;
    assert_eq!((status, &again), (200, &record));
}

#[tokio::test]
async fn a_record_is_only_ever_tightened() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let sieves = api.project("Sieves").await;
    // The chat can be found to be an untrusted run's, never the other way.
    assert_eq!(keep(&api, "s", json!({"kind": "chat"})).await.0, 200);
    let (status, record) = keep(&api, "s", json!({"kind": "untrusted"})).await;
    assert_eq!((status, record["kind"].as_str(), &record["project"]), (200, Some("untrusted"), &Value::Null));
    let (status, refused) = keep(&api, "s", json!({"kind": "chat"})).await;
    assert_eq!(status, 409, "{refused}");
    assert!(refused["message"].as_str().unwrap().contains("kept as untrusted"), "{refused}");
    // Held to a project once one is said, and never moved to another.
    let (status, record) = keep(&api, "s", json!({"kind": "untrusted", "project": primes})).await;
    assert_eq!((status, record["project"].as_str()), (200, Some(primes.as_str())));
    let (status, refused) = keep(&api, "s", json!({"kind": "untrusted", "project": sieves})).await;
    assert_eq!(status, 409, "{refused}");
    assert!(refused["message"].as_str().unwrap().contains(&format!("held to {primes}")), "{refused}");
    // Saying less leaves it be.
    let (status, record) = keep(&api, "s", json!({"kind": "untrusted"})).await;
    assert_eq!((status, record["project"].as_str()), (200, Some(primes.as_str())));
    // The chat holds no project.
    let (_, chat) = keep(&api, "c", json!({"kind": "chat", "project": primes})).await;
    assert_eq!(chat["project"], Value::Null);
}

#[tokio::test]
async fn only_the_local_app_records_a_session_and_only_as_untrusted_or_the_chat() {
    let api = TestApi::new().await;
    let outside = from_outside(api.put("/api/session-records/s", json!({"kind": "untrusted"}))).send().await;
    assert_eq!(outside.status, 403, "{}", outside.body);
    assert_eq!(keep(&api, "s", json!({"kind": "owner"})).await.0, 400);
    assert_eq!(keep(&api, "s", json!({})).await.0, 400);
    assert_eq!(keep(&api, "s", json!({"kind": "untrusted", "project": 7})).await.0, 400);
}

#[tokio::test]
async fn a_cleared_session_keeps_its_record_under_its_new_id() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let sieves = api.project("Sieves").await;
    api.record_session("old", "untrusted", Some(&primes)).await;
    let renamed = api.post(&format!("/api/projects/{primes}/issue-sessions/rename"), json!({"from": "old", "to": "new"})).send().await;
    assert_eq!(renamed.status, 200, "{}", renamed.body);
    // The new id is held as the old one was, and the old one still is.
    let (status, refused) = keep(&api, "new", json!({"kind": "untrusted", "project": sieves})).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(keep(&api, "old", json!({"kind": "chat"})).await.0, 409);
}

// ORR-1324: how a request's session ids are read, and what an untrusted request keeps when its record says chat.

#[test]
fn a_session_named_twice_by_one_request_is_one_id() {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("orrery-session", "orrery%20%C2%B7%20Mime".parse().unwrap());
    headers.insert("orrery-worked-by", " orrery%20%C2%B7%20Mime ".parse().unwrap());
    assert_eq!(crate::access::session_records::named_ids(&headers), ["orrery · Mime"]);
    headers.insert("orrery-worked-by", "  ".parse().unwrap());
    assert_eq!(crate::access::session_records::named_ids(&headers), ["orrery · Mime"], "a blank one names nobody");
}

#[tokio::test]
async fn an_untrusted_request_stays_untrusted_and_not_the_chat_when_its_record_says_chat() {
    let api = TestApi::new().await;
    assert_eq!(keep(&api, "c", json!({"kind": "chat"})).await.0, 200);
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("orrery-session", "c".parse().unwrap());
    let mut conn = api.app.pool.acquire().await.unwrap();
    let asking = crate::write::Actor { name: "claude".into(), untrusted: true, ..Default::default() };
    let (held, own) = crate::access::session_records::as_recorded(&mut conn, &headers, &asking).await.unwrap();
    assert_eq!((held.untrusted, held.chat, own), (true, false, None));
    let trusted = crate::write::Actor { name: "claude".into(), ..Default::default() };
    let (held, _) = crate::access::session_records::as_recorded(&mut conn, &headers, &trusted).await.unwrap();
    assert!(held.chat, "a trusted one is the chat, as its record says");
}

/// A request naming `session`, from `person`'s credential (`Orrery-Who`), or with login off when there's none.
fn naming(session: &str, person: Option<&str>) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("orrery-session", session.parse().unwrap());
    if let Some(person) = person {
        headers.insert("orrery-who", "agent".parse().unwrap());
        headers.insert("orrery-who-person", person.parse().unwrap());
    }
    headers
}

#[tokio::test]
async fn a_record_counts_only_for_its_person() {
    let api = TestApi::new().await;
    let own = api.project("Primes").await;
    assert_eq!(keep(&api, "ana-run", json!({"kind": "untrusted", "project": own, "person": "ana"})).await.0, 200);
    assert_eq!(keep(&api, "ana-chat", json!({"kind": "chat", "person": "ana"})).await.0, 200);
    assert_eq!(keep(&api, "old-run", json!({"kind": "untrusted", "project": own})).await.0, 200);
    let mut conn = api.app.pool.acquire().await.unwrap();
    let plain = crate::write::Actor { name: "claude".into(), ..Default::default() };

    let (headers, actor) = (naming("ana-run", Some("ana")), plain.clone());
    let (as_ana, own_ana) = crate::access::session_records::as_recorded(&mut conn, &headers, &actor).await.unwrap();
    assert_eq!((as_ana.untrusted, own_ana.as_deref()), (true, Some(own.as_str())), "ana gets her own session's project");

    let (headers, actor) = (naming("ana-run", Some("bo")), plain.clone());
    let (as_bo, own_bo) = crate::access::session_records::as_recorded(&mut conn, &headers, &actor).await.unwrap();
    assert_eq!((as_bo.untrusted, own_bo), (true, None), "bo naming ana's session is held untrusted, and gets nothing of it");

    let (headers, actor) = (naming("ana-chat", Some("bo")), plain.clone());
    let (as_bo, _) = crate::access::session_records::as_recorded(&mut conn, &headers, &actor).await.unwrap();
    assert!(!as_bo.chat, "nor is bo ana's chat");

    let (headers, actor) = (naming("old-run", Some("bo")), plain.clone());
    let (_, own_old) = crate::access::session_records::as_recorded(&mut conn, &headers, &actor).await.unwrap();
    assert_eq!(own_old, None, "a record kept for nobody counts for nobody with login on");

    let (headers, actor) = (naming("old-run", None), plain.clone());
    let (_, own_off) = crate::access::session_records::as_recorded(&mut conn, &headers, &actor).await.unwrap();
    assert_eq!(own_off.as_deref(), Some(own.as_str()), "and as before with login off");
}

#[tokio::test]
async fn a_record_is_never_given_to_someone_else() {
    let api = TestApi::new().await;
    assert_eq!(keep(&api, "ana-chat", json!({"kind": "chat", "person": "ana"})).await.0, 200);
    assert_eq!(keep(&api, "ana-chat", json!({"kind": "untrusted", "person": "bo"})).await.0, 409, "another person's");
    assert_eq!(keep(&api, "ana-chat", json!({"kind": "chat"})).await.0, 409, "nobody's");
    assert_eq!(keep(&api, "old", json!({"kind": "chat"})).await.0, 200);
    assert_eq!(keep(&api, "old", json!({"kind": "chat", "person": "bo"})).await.0, 409, "one kept for nobody stays so");
    let (status, record) = keep(&api, "ana-chat", json!({"kind": "untrusted", "person": "ana"})).await;
    assert_eq!((status, record["kind"].as_str(), record["person"].as_str()), (200, Some("untrusted"), Some("ana")));
}
