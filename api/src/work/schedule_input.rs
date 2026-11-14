// A schedule's fields as they're sent (ORR-1082): `checkInput(body, SCHEDULE_FIELDS, partial)` in
// web/server/utils/schedules.ts, with its `parseFilter` and `parsePresets`, worded as the Nuxt server words them.
use crate::error::{ApiError, Result};
use crate::write::js;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

const KINDS: [&str; 4] = ["issue", "message", "session", "action"];
const PRIORITIES: [&str; 4] = ["P0", "P1", "P2", "P3"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const EVENT_LEVELS: [&str; 3] = ["error", "warn", "info"];
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(best|opus|sonnet|haiku|fable|default|opusplan|claude-[a-z0-9.-]{1,56}(\[1m\])?)$").unwrap());
const MODEL_HINT: &str = "use best, opus, sonnet, haiku, fable, default, opusplan or a full id such as claude-sonnet-5-5";

enum Type {
    Text,
    Bool,
    /// Parsed to what's stored (`type: 'json'` with its `parse`).
    Json(fn(&Value) -> std::result::Result<String, String>),
    Strings,
}

struct Field {
    name: &'static str,
    kind: Type,
    nullable: bool,
    required: bool,
    values: &'static [&'static str],
}

const fn field(name: &'static str, kind: Type, nullable: bool) -> Field {
    Field { name, kind, nullable, required: false, values: &[] }
}

/// `SCHEDULE_FIELDS`, in its order.
const FIELDS: [Field; 21] = [
    Field { name: "kind", kind: Type::Text, nullable: false, required: false, values: &KINDS },
    Field { name: "title", kind: Type::Text, nullable: false, required: true, values: &[] },
    field("notes", Type::Text, true),
    field("cron", Type::Text, true),
    field("at", Type::Text, true),
    field("on", Type::Text, true),
    field("on_filter", Type::Json(parse_filter), true),
    field("presets", Type::Json(parse_presets), true),
    field("timezone", Type::Text, false),
    field("column", Type::Text, false),
    field("move_from", Type::Strings, true),
    field("milestone", Type::Text, true),
    Field { name: "priority", kind: Type::Text, nullable: true, required: false, values: &PRIORITIES },
    field("labels", Type::Strings, true),
    field("ask", Type::Bool, false),
    field("skip_open", Type::Bool, false),
    field("only_if_changed", Type::Bool, false),
    field("untrusted", Type::Bool, false),
    field("enabled", Type::Bool, false),
    field("model", Type::Text, true),
    Field { name: "effort", kind: Type::Text, nullable: true, required: false, values: &EFFORTS },
];

/// `parseFilter`: `{to, from, by, level}`, each optional, as it's stored.
fn parse_filter(value: &Value) -> std::result::Result<String, String> {
    let Some(sent) = value.as_object() else { return Err("send an object: {\"to\": \"in-review\"}".into()) };
    if let Some(extra) = sent.keys().find(|k| !["to", "from", "by", "level"].contains(&k.as_str())) {
        return Err(format!("\"{extra}\" isn't one; use to, from, by or level"));
    }
    for key in ["to", "from"] {
        if sent.get(key).is_some_and(|v| !v.is_string()) {
            return Err(format!("\"{key}\" is a value, e.g. \"in-review\""));
        }
    }
    if sent.get("by").is_some_and(|by| by != "owner" && by != "session") {
        return Err("\"by\" is \"owner\" or \"session\"".into());
    }
    if sent.get("level").is_some_and(|level| !level.as_str().is_some_and(|l| EVENT_LEVELS.contains(&l))) {
        return Err(format!("\"level\" is one of {}", EVENT_LEVELS.join(", ")));
    }
    let mut kept = Map::new();
    for key in ["to", "from", "by", "level"] {
        if let Some(value) = sent.get(key).filter(|v| *v != "") {
            kept.insert(key.into(), value.clone());
        }
    }
    Ok(Value::Object(kept).to_string())
}

/// `parsePresets`: a list of preset ids, each once.
fn parse_presets(value: &Value) -> std::result::Result<String, String> {
    let ids: Option<Vec<i64>> = value.as_array().and_then(|list| list.iter().map(|id| id.as_f64().filter(|n| n.fract() == 0.0).map(|n| n as i64)).collect());
    let Some(ids) = ids else { return Err("send a list of preset ids, e.g. [3, 7]".into()) };
    let mut once: Vec<i64> = vec![];
    for id in ids {
        if !once.contains(&id) {
            once.push(id);
        }
    }
    Ok(json!(once).to_string())
}

/// The fields sent, checked: a `json` one as it's stored (a string), `strings` trimmed and each once.
pub fn check_input(body: &Value, partial: bool) -> Result<Map<String, Value>> {
    let Some(sent) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
    let names: Vec<&str> = FIELDS.iter().map(|f| f.name).collect();
    let mut problems: Vec<String> =
        sent.keys().filter(|k| !names.contains(&k.as_str())).map(|k| format!("unknown field \"{k}\"; this takes {}", names.join(", "))).collect();
    let mut input = Map::new();
    for field in &FIELDS {
        let key = field.name;
        let Some(value) = sent.get(key) else {
            if field.required && !partial {
                problems.push(format!("missing \"{key}\""));
            }
            continue;
        };
        if value.is_null() {
            if field.nullable {
                input.insert(key.into(), Value::Null);
            } else {
                problems.push(format!("\"{key}\" can't be null"));
            }
            continue;
        }
        match field.kind {
            Type::Json(parse) => match parse(value) {
                Ok(stored) => {
                    input.insert(key.into(), Value::String(stored));
                }
                Err(why) => problems.push(format!("\"{key}\": {why}")),
            },
            Type::Strings => {
                let list: Option<Vec<String>> =
                    value.as_array().and_then(|l| l.iter().map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)).collect());
                match list {
                    Some(list) => {
                        let mut once: Vec<String> = vec![];
                        for item in list {
                            if !once.contains(&item) {
                                once.push(item);
                            }
                        }
                        input.insert(key.into(), json!(once));
                    }
                    None => problems.push(format!("\"{key}\" should be a list of strings, not {}", js(value))),
                }
            }
            Type::Bool => match value.as_bool() {
                Some(_) => {
                    input.insert(key.into(), value.clone());
                }
                None => problems.push(format!("\"{key}\" should be a boolean, not {}", js(value))),
            },
            Type::Text => {
                let Some(text) = value.as_str() else {
                    problems.push(format!("\"{key}\" should be a string, not {}", js(value)));
                    continue;
                };
                if !field.values.is_empty() && !field.values.contains(&text) {
                    let or_null = if field.nullable { " (or null)" } else { "" };
                    problems.push(format!("\"{key}\" is \"{text}\", not one of {}{or_null}", field.values.join(", ")));
                    continue;
                }
                if key == "model" && !MODEL.is_match(text) {
                    problems.push(format!("\"{key}\" is \"{text}\"; {MODEL_HINT}"));
                    continue;
                }
                if field.required && text.trim().is_empty() {
                    problems.push(format!("\"{key}\" can't be empty"));
                    continue;
                }
                input.insert(key.into(), value.clone());
            }
        }
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(input)
}

#[cfg(test)]
#[path = "schedule_input_tests.rs"]
mod tests;
