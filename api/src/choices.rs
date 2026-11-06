// A proposal's choices (ORR-927): checked as `parseChoices` in web/server/utils/choices.ts checks them, in its order, and
// kept as the JSON it gives back, so the store and the API keep the same text.
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;

static KEY: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$").unwrap());

#[derive(Serialize)]
struct Choice {
    key: String,
    question: String,
    pick: String,
    options: Vec<Opt>,
    recommended: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<From>,
}

#[derive(Serialize)]
struct Opt {
    key: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

#[derive(Serialize)]
struct From {
    choice: String,
    option: String,
}

/// Text that isn't blank, trimmed (`text`).
fn text(value: Option<&Value>, what: &str) -> Result<String, String> {
    match value.and_then(Value::as_str).map(str::trim) {
        Some(sent) if !sent.is_empty() => Ok(sent.to_string()),
        _ => Err(format!("{what} should be text")),
    }
}

/// A value as JavaScript's `String()` writes it, for what a message quotes.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(list) => list.iter().map(|v| if v.is_null() { String::new() } else { js_string(v) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

/// Checks a list of choices and gives it back as JSON (`parseChoices`): keys unique, each choice with two options or
/// more, its recommendation among them (one at most for `pick: one`), and `from` naming an earlier choice's option.
pub fn parse_choices(value: &Value) -> Result<String, String> {
    let Some(list) = value.as_array() else { return Err("should be a list of {key, question, pick, options, recommended?, from?}".into()) };
    let mut choices: Vec<Choice> = vec![];
    for (i, raw) in list.iter().enumerate() {
        let at = format!("choice {}", i + 1);
        let Some(raw) = raw.as_object() else { return Err(format!("{at} should be an object")) };
        let key = text(raw.get("key"), &format!("{at}'s \"key\""))?;
        if !KEY.is_match(&key) {
            return Err(format!("{at}'s key \"{key}\" should be letters, digits, - or _"));
        }
        if choices.iter().any(|c| c.key == key) {
            return Err(format!("two choices have the key \"{key}\""));
        }
        let pick = match raw.get("pick") {
            None | Some(Value::Null) => "one".to_string(),
            Some(Value::String(p)) if p == "one" || p == "any" => p.clone(),
            Some(other) => return Err(format!("{key}'s \"pick\" is \"{}\", not one or any", js_string(other))),
        };
        let Some(sent) = raw.get("options").and_then(Value::as_array).filter(|o| o.len() >= 2) else {
            return Err(format!("{key} needs two options or more"));
        };
        let mut options: Vec<Opt> = vec![];
        for (j, option) in sent.iter().enumerate() {
            let Some(option) = option.as_object() else { return Err(format!("{key}'s option {} should be an object", j + 1)) };
            let body = match option.get("body") {
                None | Some(Value::Null) => None,
                given => Some(text(given, &format!("{key}'s option {} \"body\"", j + 1))?),
            };
            let option_key = text(option.get("key"), &format!("{key}'s option {} \"key\"", j + 1))?;
            let title = text(option.get("title"), &format!("{key}'s option {} \"title\"", j + 1))?;
            options.push(Opt { key: option_key, title, body });
        }
        if options.iter().enumerate().any(|(n, o)| options[..n].iter().any(|p| p.key == o.key)) {
            return Err(format!("{key} has two options with the same key"));
        }
        let recommended = match raw.get("recommended") {
            None => Some(vec![]),
            Some(Value::Array(list)) => {
                list.iter().map(|r| r.as_str().filter(|r| options.iter().any(|o| o.key == *r)).map(String::from)).collect::<Option<Vec<_>>>()
            }
            Some(_) => None,
        };
        let Some(recommended) = recommended else { return Err(format!("{key}'s \"recommended\" should list its options' keys")) };
        if pick == "one" && recommended.len() > 1 {
            return Err(format!("{key} is pick one, so it recommends one option at most"));
        }
        let from = match raw.get("from") {
            None | Some(Value::Null) => None,
            Some(Value::Object(given)) => {
                let parent = given.get("choice").and_then(Value::as_str).and_then(|c| choices.iter().find(|p| p.key == c));
                let option = given.get("option").and_then(Value::as_str);
                match (parent, option) {
                    (Some(parent), Some(option)) if parent.options.iter().any(|o| o.key == option) => {
                        Some(From { choice: parent.key.clone(), option: option.to_string() })
                    }
                    _ => return Err(format!("{key}'s \"from\" should name an option of a choice before it")),
                }
            }
            Some(_) => return Err(format!("{key}'s \"from\" should be {{choice, option}}")),
        };
        let question = text(raw.get("question"), &format!("{key}'s \"question\""))?;
        choices.push(Choice { key, question, pick, options, recommended, from });
    }
    Ok(serde_json::to_string(&choices).unwrap_or_default())
}

#[cfg(test)]
mod tests {
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
}
