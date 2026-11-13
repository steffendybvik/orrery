use super::*;
use serde_json::json;

#[test]
fn checks_a_release_as_release_fields_do() {
    assert!(check_input(&json!({"version": "1.0.0-rc.2", "branch": null, "shipped_on": "2026-11-05", "position": 0}), false).is_ok());
    assert!(check_input(&json!({}), true).is_ok());
    for body in [
        json!({}),
        json!({"version": ""}),
        json!({"version": "1.0", "shipped_on": "today"}),
        json!({"version": "1.0", "colour": "red"}),
        json!({"version": null}),
    ] {
        assert!(check_input(&body, false).is_err(), "{body}");
    }
}

#[test]
fn keeps_a_branch_trimmed_or_none() {
    assert_eq!(branch_of(Some("  rc  ".into())), Some("rc".into()));
    assert_eq!(branch_of(Some("   ".into())), None);
    assert_eq!(branch_of(None), None);
}
