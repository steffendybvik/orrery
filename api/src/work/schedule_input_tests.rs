use super::*;

fn problems(body: Value) -> Vec<String> {
    let error = check_input(&body, true).expect_err("refused");
    error.data.as_ref().and_then(|d| d["problems"].as_array()).map(|p| p.iter().map(|m| m.as_str().unwrap().to_string()).collect()).unwrap_or_default()
}

#[test]
fn checks_each_field_as_check_input_does() {
    assert_eq!(problems(json!({"nope": 1})), [format!("unknown field \"nope\"; this takes {}", FIELDS.map(|f| f.name).join(", "))]);
    assert_eq!(problems(json!({"title": " "})), ["\"title\" can't be empty"]);
    assert_eq!(problems(json!({"kind": "x"})), ["\"kind\" is \"x\", not one of issue, message, session, action"]);
    assert_eq!(problems(json!({"priority": "P9"})), ["\"priority\" is \"P9\", not one of P0, P1, P2, P3 (or null)"]);
    assert_eq!(problems(json!({"ask": "yes"})), ["\"ask\" should be a boolean, not \"yes\""]);
    assert_eq!(problems(json!({"timezone": null})), ["\"timezone\" can't be null"]);
    assert_eq!(problems(json!({"labels": ["a", ""]})), ["\"labels\" should be a list of strings, not [\"a\",\"\"]"]);
    assert_eq!(problems(json!({"model": "gpt"})), [format!("\"model\" is \"gpt\"; {MODEL_HINT}")]);
    assert_eq!(problems(json!({"presets": [1.5]})), ["\"presets\": send a list of preset ids, e.g. [3, 7]"]);
    assert_eq!(problems(json!({"on_filter": {"x": 1}})), ["\"on_filter\": \"x\" isn't one; use to, from, by or level"]);
    assert_eq!(problems(json!({"on_filter": {"by": "me"}})), ["\"on_filter\": \"by\" is \"owner\" or \"session\""]);
    assert_eq!(problems(json!({"on_filter": {"level": "loud"}})), ["\"on_filter\": \"level\" is one of error, warn, info"]);
    assert_eq!(check_input(&json!([]), true).err().unwrap().message, "The body should be a JSON object");
    assert_eq!(check_input(&json!({"ask": 1, "kind": 2}), true).err().unwrap().message, "2 problems in the body");
}

#[test]
fn keeps_what_is_stored() {
    let input =
        check_input(&json!({"presets": [3, 3, 7], "on_filter": {"level": "warn", "to": "done", "from": ""}, "labels": [" a ", "a", "b"]}), true).unwrap();
    assert_eq!(input["presets"], "[3,7]");
    assert_eq!(input["on_filter"], "{\"to\":\"done\",\"level\":\"warn\"}");
    assert_eq!(input["labels"], json!(["a", "b"]));
    assert!(check_input(&json!({}), false).is_err(), "a title is needed to make one");
}
