use super::*;
use serde_json::json;

#[test]
fn checks_words_as_check_input_does() {
    let words = check_words(&json!({"title": "  Oak  ", "labels": [" a", "a", "b"], "notes": null, "position": 2})).unwrap();
    assert_eq!(words.title.as_deref(), Some("Oak"));
    assert_eq!(words.labels, Some(vec!["a".to_string(), "b".to_string()]));
    assert_eq!(words.notes, Some(None));
    assert_eq!(words.position, Some(2.0));
    assert_eq!(check_words(&json!({"github_issues": [12, " o/n#3 "]})).unwrap().github_issues, Some(vec!["12".to_string(), "o/n#3".to_string()]));
    let refused = check_words(&json!({"status": 3, "title": "", "model": "gpt", "effort": "huge", "position": null})).unwrap_err();
    assert_eq!(refused.message, "5 problems in the body");
    assert_eq!(check_words(&json!({"proposal": null})).unwrap().proposal, Some(None));
    assert_eq!(check_words(&json!({"proposal": "pending"})).unwrap().proposal, Some(Some("pending".to_string())));
    assert!(check_words(&json!({"proposal": "changes"})).is_err());
    assert!(check_words(&json!({"github_issues": [0]})).is_err() && check_words(&json!({"labels": ["", "a"]})).is_err());
    assert!(check_words(&json!([])).is_err());
    assert_eq!(check_words(&json!({"epic": 3})).unwrap().epic, Some(Some("3".to_string())));
    assert_eq!(check_words(&json!({"epic": " EPC-3 "})).unwrap().epic, Some(Some("EPC-3".to_string())));
    assert_eq!(check_words(&json!({"epic": null})).unwrap().epic, Some(None));
    assert!(check_words(&json!({"epic": 1.5})).is_err() && check_words(&json!({"epic": " "})).is_err() && check_words(&json!({"epic": true})).is_err());
}

#[test]
fn finds_an_epics_number_as_number_of_does() {
    let uid = "x7k2m9qd";
    for (sent, number) in [("14", Some("14")), ("EPC-14", Some("14")), ("epc-14", Some("14")), ("EPC-14-x7k2m9qd", Some("14"))] {
        assert_eq!(epic_number(sent, uid).as_deref(), number, "{sent}");
    }
    for sent in ["EPC-14-aaaaaaaa", "Launch", "EPC-", "MLS-14", "épc-1"] {
        assert_eq!(epic_number(sent, uid), None, "{sent}");
    }
}
