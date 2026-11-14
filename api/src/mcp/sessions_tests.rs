// The MCP sessions kept in memory (ORR-1167).
use super::Sessions;

#[test]
fn a_session_keeps_each_group_it_loads_once_in_order() {
    let sessions = Sessions::default();
    let id = sessions.begin();
    sessions.load(Some(&id), "docs");
    sessions.load(Some(&id), "plans");
    sessions.load(Some(&id), "docs");
    assert_eq!(sessions.loaded(Some(&id)), ["docs", "plans"]);
}

#[test]
fn an_unknown_session_or_none_has_nothing_loaded_and_keeps_nothing() {
    let sessions = Sessions::default();
    sessions.load(Some("nobody"), "docs");
    sessions.load(None, "docs");
    assert!(sessions.loaded(Some("nobody")).is_empty());
    assert!(sessions.loaded(None).is_empty());
}

#[test]
fn ending_a_session_forgets_it_once() {
    let sessions = Sessions::default();
    let id = sessions.begin();
    sessions.load(Some(&id), "docs");
    assert!(sessions.end(&id));
    assert!(!sessions.end(&id));
    assert!(sessions.loaded(Some(&id)).is_empty());
    assert!(sessions.0.lock().unwrap().began.is_empty(), "nothing left to let go of later");
}

#[test]
fn past_the_cap_the_oldest_session_goes_first() {
    let sessions = Sessions::default();
    let ids: Vec<String> = (0..3).map(|_| sessions.begin_within(3)).collect();
    for id in &ids {
        sessions.load(Some(id), "docs");
    }
    let newest = sessions.begin_within(3);
    assert!(sessions.loaded(Some(&ids[0])).is_empty(), "the oldest went");
    assert_eq!(sessions.loaded(Some(&ids[1])), ["docs"]);
    assert_eq!(sessions.loaded(Some(&ids[2])), ["docs"]);
    assert!(sessions.loaded(Some(&newest)).is_empty());
    assert_eq!(sessions.0.lock().unwrap().loaded.len(), 3);
}

#[test]
fn a_session_ended_early_doesnt_count_toward_the_cap() {
    let sessions = Sessions::default();
    let first = sessions.begin_within(2);
    let second = sessions.begin_within(2);
    sessions.load(Some(&first), "docs");
    assert!(sessions.end(&second));
    sessions.begin_within(2);
    assert_eq!(sessions.loaded(Some(&first)), ["docs"], "still room for it");
}

#[test]
fn a_claude_session_that_chose_another_orrery_keeps_its_first_choice() {
    let sessions = Sessions::default();
    assert!(sessions.other_choice(Some("c1")).is_none());
    assert!(sessions.other_choice(None).is_none());
    sessions.chose_other("c1", serde_json::json!({"id": "work"}));
    sessions.chose_other("c1", serde_json::json!({"id": "personal"}));
    assert_eq!(sessions.other_choice(Some("c1")).unwrap()["id"], "work", "a session chooses once");
    assert!(sessions.other_choice(Some("c2")).is_none());
}

#[test]
fn past_the_cap_the_oldest_choice_goes_first() {
    let sessions = Sessions::default();
    for claude in ["c1", "c2", "c3"] {
        sessions.chose_other_within(claude, serde_json::json!({"id": "work"}), 2);
    }
    assert!(sessions.other_choice(Some("c1")).is_none(), "the oldest went");
    assert!(sessions.other_choice(Some("c2")).is_some());
    assert!(sessions.other_choice(Some("c3")).is_some());
}
