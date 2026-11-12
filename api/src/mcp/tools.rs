// The tools `/mcp` lists to each kind of session (ORR-1098), as `toolsFor` in channel/tools.mjs lists them: a work
// session's, with the groups of `on_demand` it hasn't loaded behind `more_tools`; the chat's; an untrusted session's.
// With several projects, each project-scoped tool takes which. The lists are api/mcp-tools.json, written from
// channel/tools.mjs by web/test/rust-mcp-tools.test.ts: don't edit it by hand.
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::LazyLock;

#[derive(Deserialize)]
pub(crate) struct Lists {
    work: Vec<Value>,
    chat: Vec<Value>,
    untrusted: Vec<Value>,
    more_tools: Value,
    on_demand: BTreeMap<String, Vec<String>>,
    scoped: Vec<String>,
    chat_requests: Vec<Value>,
}

pub(crate) static LISTS: LazyLock<Lists> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../mcp-tools.json")).expect("api/mcp-tools.json is the channel's tool lists"));

/// Which kind of session is asking, as the router says (`Orrery-Actor-Kind`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Kind {
    Work,
    Chat,
    Untrusted,
}

/// The groups a work session can load with `more_tools`, and the tools in each.
pub(crate) fn group(name: &str) -> Option<&'static [String]> {
    LISTS.on_demand.get(name).map(Vec::as_slice)
}

pub(crate) fn groups() -> Vec<&'static str> {
    LISTS.on_demand.keys().map(String::as_str).collect()
}

/// The chat's `request` actions (`CHAT_REQUESTS`), by name, as `request_fields` describes them.
pub(crate) fn chat_request(action: &str) -> Option<&'static Value> {
    LISTS.chat_requests.iter().find(|r| name_of(r) == action)
}

/// What the chat is told when it names an action there isn't, as the channel's `callTool` tells it.
pub(crate) fn no_action(action: &Value) -> String {
    let names: Vec<&str> = LISTS.chat_requests.iter().map(name_of).collect();
    let named = action.as_str().map(str::to_string).unwrap_or_else(|| if action.is_null() { "undefined".into() } else { action.to_string() });
    format!("No action \"{named}\": one of {}", names.join(", "))
}

/// `request_fields`: what an action does and the fields it takes, as the channel's `callTool` says it.
pub(crate) fn request_fields(action: &Value) -> std::result::Result<String, String> {
    let request = action.as_str().and_then(chat_request).ok_or_else(|| no_action(action))?;
    Ok(format!("{}: {}\n\nfields: {}", name_of(request), request["description"].as_str().unwrap_or_default(), request["inputSchema"]))
}

fn name_of(tool: &Value) -> &str {
    tool["name"].as_str().unwrap_or_default()
}

/// The tools as `toolsFor(projects, {chat, untrusted, loaded})` lists them.
pub(crate) fn tools_for(projects: &[String], kind: Kind, loaded: &[String]) -> Vec<Value> {
    let tools: Vec<Value> = match kind {
        Kind::Chat => LISTS.chat.clone(),
        Kind::Untrusted => LISTS.untrusted.clone(),
        Kind::Work => {
            let later: Vec<&String> = LISTS.on_demand.iter().filter(|(g, _)| !loaded.contains(g)).flat_map(|(_, names)| names).collect();
            let mut tools: Vec<Value> = LISTS.work.iter().filter(|t| !later.iter().any(|n| *n == name_of(t))).cloned().collect();
            if !later.is_empty() {
                tools.push(LISTS.more_tools.clone());
            }
            tools
        }
    };
    if projects.len() < 2 {
        return tools;
    }
    let listed = projects.join(", ");
    let project = json!({"type": "string", "enum": projects, "description": format!("Which project: {listed}")});
    tools
        .into_iter()
        .map(|mut tool| {
            let name = name_of(&tool).to_string();
            let schema = tool["inputSchema"].as_object_mut().expect("a tool has its inputSchema");
            if LISTS.scoped.contains(&name) {
                let mut required = vec![json!("project")];
                required.extend(schema.get("required").and_then(Value::as_array).cloned().unwrap_or_default());
                schema.insert("required".into(), Value::Array(required));
                let mut properties = Map::new();
                properties.insert("project".into(), project.clone());
                properties.extend(schema.get("properties").and_then(Value::as_object).cloned().unwrap_or_default());
                schema.insert("properties".into(), Value::Object(properties));
            } else if name == "egress" {
                let mut egress = project.clone();
                egress["description"] = json!(format!("Which project it's for, when no issue says: {listed}"));
                if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
                    properties.insert("project".into(), egress);
                }
            }
            tool
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Check {
        name: String,
        projects: Vec<String>,
        kind: String,
        loaded: Vec<String>,
        tools: Vec<Value>,
    }

    #[test]
    fn each_kinds_list_is_the_channels() {
        let checks: Vec<Check> = serde_json::from_str(include_str!("../../mcp-tools-checks.json")).unwrap();
        assert!(checks.len() >= 6);
        for check in checks {
            let kind = match check.kind.as_str() {
                "chat" => Kind::Chat,
                "untrusted" => Kind::Untrusted,
                _ => Kind::Work,
            };
            assert_eq!(tools_for(&check.projects, kind, &check.loaded), check.tools, "{}", check.name);
        }
    }

    #[test]
    fn a_work_session_gets_a_group_only_once_it_loads_it() {
        let one = ["one".to_string()];
        let names = |tools: Vec<Value>| tools.iter().map(|t| name_of(t).to_string()).collect::<Vec<_>>();
        let bare = names(tools_for(&one, Kind::Work, &[]));
        assert!(bare.contains(&"more_tools".into()) && !bare.contains(&"egress".into()));
        let loaded = names(tools_for(&one, Kind::Work, &["secrets".into()]));
        assert!(loaded.contains(&"egress".into()) && loaded.contains(&"more_tools".into()));
        let all: Vec<String> = groups().iter().map(|g| g.to_string()).collect();
        assert!(!names(tools_for(&one, Kind::Work, &all)).contains(&"more_tools".into()));
    }

    #[test]
    fn neither_the_chat_nor_an_untrusted_session_gets_more_tools_or_takes_up_work() {
        let one = ["one".to_string()];
        for kind in [Kind::Chat, Kind::Untrusted] {
            let names: Vec<String> = tools_for(&one, kind, &[]).iter().map(|t| name_of(t).to_string()).collect();
            for refused in ["more_tools", "start_issue", "finish_issue", "update_issue"] {
                assert!(!names.contains(&refused.to_string()), "{kind:?} has {refused}");
            }
        }
    }
}
