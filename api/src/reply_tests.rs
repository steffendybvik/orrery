use super::*;
use crate::write::Told;
use serde_json::json;

fn encode(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn header(response: &Response, name: &str) -> Option<String> {
    response.headers().get(name).map(|v| v.to_str().unwrap().to_string())
}

async fn body(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    }
}

#[test]
fn tells_an_event_with_its_values_only_when_one_changed() {
    let plain = Told { kind: "doc.created".into(), project: "primes".into(), subject: "plan".into(), ..Told::default() };
    assert_eq!(told_of(&plain, &encode), "doc%2Ecreated primes plan");
    let changed = Told { kind: "issue.status".into(), project: "my board".into(), subject: "PRI-1".into(), from: Some("todo".into()), to: None };
    assert_eq!(told_of(&changed, &encode), "issue%2Estatus my%20board PRI%2D1 todo ~");
    let set = Told { from: None, to: Some("~".into()), ..changed };
    assert_eq!(told_of(&set, &encode), "issue%2Estatus my%20board PRI%2D1 ~ %7E", "a value that's `~` is never a bare one");
}

#[tokio::test]
async fn a_reply_that_changed_nothing_has_no_orrery_headers() {
    let response = reply(StatusCode::OK, Some(json!({"ok": true})), Effects::default());
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().keys().all(|n| !n.as_str().starts_with("orrery-")), "{:?}", response.headers());
    assert_eq!(body(response).await, json!({"ok": true}));
    let empty = reply(StatusCode::NO_CONTENT, None, Effects::default());
    assert_eq!(empty.status(), StatusCode::NO_CONTENT);
    assert_eq!(body(empty).await, Value::Null);
}

#[test]
fn a_reply_says_what_its_write_changed_each_part_encoded() {
    let mut effects = Effects {
        changed: vec!["primes".into(), "my board".into()],
        settings: true,
        epics: true,
        settings_keys: vec!["theme".into(), "auth_on".into()],
        schedules: vec!["primes".into(), "my board".into()],
        ..Effects::default()
    };
    effects.tell("doc.created", "primes", "plan");
    effects.tell_change("issue.assignee", "my board", "MY-2", Some("ada"), None);
    let response = reply(StatusCode::CREATED, Some(json!({})), effects);
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(header(&response, "orrery-changed").as_deref(), Some("primes, my%20board"));
    assert_eq!(header(&response, "orrery-settings").as_deref(), Some("1"));
    assert_eq!(header(&response, "orrery-epics").as_deref(), Some("1"));
    assert_eq!(header(&response, "orrery-settings-keys").as_deref(), Some("theme, auth%5Fon"));
    assert_eq!(header(&response, "orrery-schedules").as_deref(), Some("primes, my%20board"));
    assert_eq!(header(&response, "orrery-told").as_deref(), Some("doc%2Ecreated primes plan, issue%2Eassignee my%20board MY%2D2 ada ~"));
}

#[test]
fn a_comma_in_a_part_cant_split_the_list() {
    let mut effects = Effects { changed: vec!["a, b".into()], ..Effects::default() };
    effects.tell_change("issue.title", "a, b", "X-1", Some("one, two"), Some("three"));
    let response = reply(StatusCode::OK, None, effects);
    assert_eq!(header(&response, "orrery-changed").as_deref(), Some("a%2C%20b"));
    let told = header(&response, "orrery-told").unwrap();
    assert_eq!(told.split(", ").count(), 1, "{told}");
    assert_eq!(told, "issue%2Etitle a%2C%20b X%2D1 one%2C%20two three");
}

#[test]
fn only_what_changed_is_said() {
    let response = reply(StatusCode::OK, None, Effects { settings: true, ..Effects::default() });
    assert_eq!(header(&response, "orrery-settings").as_deref(), Some("1"));
    for name in ["orrery-changed", "orrery-epics", "orrery-schedules", "orrery-settings-keys", "orrery-told"] {
        assert_eq!(header(&response, name), None, "{name}");
    }
}
