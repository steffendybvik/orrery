use super::*;

#[test]
fn checks_a_comment_as_check_input_does() {
    assert_eq!(check_input(&json!({"body": "Oiled"}), false).unwrap().as_deref(), Some("Oiled"));
    assert_eq!(check_input(&json!({}), true).unwrap(), None);
    assert!(check_input(&json!({}), false).is_err());
    assert!(check_input(&json!({"body": " "}), true).is_err());
    assert!(check_input(&json!({"body": 1, "asks": "decision"}), false).is_err());
}
