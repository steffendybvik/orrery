use super::*;

#[test]
fn checks_an_epic_as_check_input_does() {
    assert!(check_input(&json!({"title": "  Gears  ", "notes": null, "position": 1}), false).is_ok());
    assert!(check_input(&json!({"notes": "x"}), true).is_ok());
    assert!(check_input(&json!({"title": " "}), false).is_err());
    assert!(check_input(&json!({"bogus": 1}), true).is_err());
    assert!(check_input(&json!([]), true).is_err());
}
