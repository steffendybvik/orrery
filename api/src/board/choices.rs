// A proposal's choices (ORR-927): checked as `parseChoices` in web/server/utils/choices.ts checks them, in its order, and
// kept as the JSON it gives back, so the store and the API keep the same text.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::LazyLock;

static KEY: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$").unwrap());

#[derive(Serialize, Deserialize)]
pub struct Choice {
    pub key: String,
    pub question: String,
    #[serde(default)]
    pub pick: String,
    pub options: Vec<Opt>,
    #[serde(default)]
    pub recommended: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<From>,
}

#[derive(Serialize, Deserialize)]
pub struct Opt {
    pub key: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct From {
    pub choice: String,
    pub option: String,
}

/// A proposal's choices as they're kept (`JSON.parse(row.choices)`): none when there are none, or they won't read.
pub fn stored(text: &str) -> Vec<Choice> {
    serde_json::from_str(text).unwrap_or_default()
}

/// The picks as they're sent and kept: choice → options, in the order they came.
pub type Picks = Map<String, Value>;

fn picked(picks: &Picks, key: &str) -> Vec<String> {
    picks.get(key).and_then(Value::as_array).map(|list| list.iter().filter_map(|p| p.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// The choices that apply with these picks (`liveChoices`): those at the top, and those down an option that was picked.
fn live<'a>(choices: &'a [Choice], picks: &Picks) -> Vec<&'a Choice> {
    let mut live: Vec<&Choice> = vec![];
    for choice in choices {
        let down = match &choice.from {
            None => true,
            Some(from) => live.iter().any(|c| c.key == from.choice) && picked(picks, &from.choice).contains(&from.option),
        };
        if down {
            live.push(choice);
        }
    }
    live
}

/// The options approving takes (`resolvePicks`): those sent, else each choice's recommendation, for the choices that
/// apply, each checked against its options, once each, and one for a `pick: one`.
pub fn resolve_picks(choices: &[Choice], sent: &Picks) -> Result<Picks, String> {
    for key in sent.keys() {
        if !choices.iter().any(|c| c.key == *key) {
            return Err(format!("there's no choice \"{key}\"; the choices are {}", choices.iter().map(|c| c.key.as_str()).collect::<Vec<_>>().join(", ")));
        }
    }
    let mut picks = Picks::new();
    for choice in choices {
        let value = match sent.get(&choice.key) {
            Some(value) if !value.is_null() => value.clone(),
            _ => Value::from(choice.recommended.clone()),
        };
        picks.insert(choice.key.clone(), value);
    }
    let mut resolved = Picks::new();
    for choice in live(choices, &picks) {
        let chosen = picked(&picks, &choice.key);
        let unknown: Vec<&str> = chosen.iter().filter(|p| !choice.options.iter().any(|o| o.key == **p)).map(String::as_str).collect();
        if !unknown.is_empty() {
            return Err(format!("{} has no option {}", choice.key, unknown.join(", ")));
        }
        if choice.pick == "one" && chosen.len() != 1 {
            return Err(format!("pick one option for {} ({})", choice.key, choice.question));
        }
        let mut once: Vec<String> = vec![];
        for p in chosen {
            if !once.contains(&p) {
                once.push(p);
            }
        }
        resolved.insert(choice.key.clone(), Value::from(once));
    }
    Ok(resolved)
}

/// The picks in words, a line per choice (`describePicks`): `- Which store? → **A** SQLite`, an option's key going with
/// its title only when it's a label (`A`, `B2`).
pub fn describe_picks(choices: &[Choice], picks: &Picks) -> String {
    let label = |key: &str| {
        let b = key.as_bytes();
        (b.len() == 1 || (b.len() == 2 && b[1].is_ascii_digit())) && b[0].is_ascii_uppercase()
    };
    choices
        .iter()
        .filter(|c| picks.contains_key(&c.key))
        .map(|c| {
            let chosen = picked(picks, &c.key);
            let named: Vec<String> = c
                .options
                .iter()
                .filter(|o| chosen.contains(&o.key))
                .map(|o| if label(&o.key) { format!("**{}** {}", o.key, o.title) } else { format!("**{}**", o.title) })
                .collect();
            format!("- {} → {}", c.question, if named.is_empty() { "none".to_string() } else { named.join(", ") })
        })
        .collect::<Vec<_>>()
        .join("\n")
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
#[path = "choices_tests.rs"]
mod tests;
