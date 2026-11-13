use super::*;
use serde_json::json;

#[test]
fn checks_and_keeps_choices_as_parse_choices_does() {
    let kept = parse_choices(&json!([
            {"key": "store", "question": " Which store? ", "options": [{"key": "A", "title": " SQLite ", "body": null}, {"key": "B", "title": "Postgres", "body": "Hosted"}], "recommended": ["A"]},
            {"key": "pool", "question": "How big?", "pick": "any", "options": [{"key": "s", "title": "Small"}, {"key": "l", "title": "Large"}], "from": {"choice": "store", "option": "B"}},
        ]))
        .unwrap();
    assert_eq!(
        kept,
        r#"[{"key":"store","question":"Which store?","pick":"one","options":[{"key":"A","title":"SQLite"},{"key":"B","title":"Postgres","body":"Hosted"}],"recommended":["A"]},{"key":"pool","question":"How big?","pick":"any","options":[{"key":"s","title":"Small"},{"key":"l","title":"Large"}],"recommended":[],"from":{"choice":"store","option":"B"}}]"#
    );
    let two = json!([{"key": "x", "title": "X"}, {"key": "y", "title": "Y"}]);
    for (sent, problem) in [
        (json!({}), "should be a list of {key, question, pick, options, recommended?, from?}"),
        (json!([1]), "choice 1 should be an object"),
        (json!([{"key": "-a"}]), "choice 1's key \"-a\" should be letters, digits, - or _"),
        (json!([{"key": "a", "pick": 3, "options": two}]), "a's \"pick\" is \"3\", not one or any"),
        (json!([{"key": "a", "options": [{"key": "x", "title": "X"}]}]), "a needs two options or more"),
        (json!([{"key": "a", "options": [{"key": "x", "title": "X", "body": " "}, {"key": "y"}]}]), "a's option 1 \"body\" should be text"),
        (json!([{"key": "a", "options": [{"key": "x", "title": "X"}, {"key": "x", "title": "Y"}]}]), "a has two options with the same key"),
        (json!([{"key": "a", "options": two, "recommended": ["z"]}]), "a's \"recommended\" should list its options' keys"),
        (json!([{"key": "a", "options": two, "recommended": ["x", "y"]}]), "a is pick one, so it recommends one option at most"),
        (json!([{"key": "a", "options": two, "from": {"choice": "a", "option": "x"}}]), "a's \"from\" should name an option of a choice before it"),
        (json!([{"key": "a", "options": two, "from": "a"}]), "a's \"from\" should be {choice, option}"),
        (json!([{"key": "a", "options": two}]), "a's \"question\" should be text"),
        (json!([{"key": "a", "question": "Q", "options": two}, {"key": "a"}]), "two choices have the key \"a\""),
    ] {
        assert_eq!(parse_choices(&sent).unwrap_err(), problem, "{sent}");
    }
}
