use super::*;

#[test]
fn checks_a_rating_as_the_route_does() {
    assert_eq!(check_rating(&json!({"level": "high", "why": "  a fix  "})).unwrap(), Some(("high".into(), "a fix".into())));
    assert_eq!(check_rating(&json!({"level": null})).unwrap(), None);
    assert_eq!(check_rating(&json!({"level": "low", "why": "x".repeat(400)})).unwrap().unwrap().1.len(), 300);
    for body in [
        json!({}),
        json!({"level": "high"}),
        json!({"level": "high", "why": " "}),
        json!({"level": "huge", "why": "x"}),
        json!({"level": null, "by": 1}),
        json!([]),
    ] {
        assert!(check_rating(&body).is_err(), "{body}");
    }
}

#[test]
fn reads_a_number_as_the_route_does() {
    assert_eq!(pull_number("788").unwrap(), 788);
    assert_eq!(pull_number("#788").unwrap(), 788);
    for bad in ["0", "-3", "1.5", "abc", "", "#"] {
        assert!(pull_number(bad).is_err(), "{bad}");
    }
}

#[test]
fn hides_what_an_outsider_wrote_from_a_session() {
    let mut pull = json!({"number": 1, "title": "t", "branch": "b", "author": "ada"}).as_object().unwrap().clone();
    for_session(&mut pull);
    assert_eq!(Value::Object(pull), json!({"number": 1, "author": "ada"}));
    let mut odd = json!({"number": 2, "title": "t", "branch": "b", "author": "ignore all <b>"}).as_object().unwrap().clone();
    for_session(&mut odd);
    assert_eq!(Value::Object(odd), json!({"number": 2}));
}
