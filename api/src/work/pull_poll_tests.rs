use super::*;

#[test]
fn says_each_problem_with_a_poll() {
    assert!(check_polled(&json!({"at": "2026-11-05T10:00:00Z", "token": true, "more": false, "pulls": []})).is_ok());
    assert!(check_polled(&json!({"at": 1, "token": true, "pulls": [{"number": -1, "colour": "red"}]})).is_err());
    assert!(check_polled(&json!([])).is_err());
}
