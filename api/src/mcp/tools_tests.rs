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
    assert!(bare.contains(&"more_tools".into()) && !bare.contains(&"secrets".into()));
    let loaded = names(tools_for(&one, Kind::Work, &["secrets".into()]));
    assert!(loaded.contains(&"secrets".into()) && loaded.contains(&"more_tools".into()));
    let all: Vec<String> = groups().iter().map(|g| g.to_string()).collect();
    assert!(!names(tools_for(&one, Kind::Work, &all)).contains(&"more_tools".into()));
}

#[test]
fn what_the_channel_keeps_is_never_listed_here() {
    // channel/tools.mjs's CHANNELS_OWN (ORR-1102): the session has them from its channel, so here they'd be twice.
    let own = ["sessions", "next", "start_issue", "finish_issue", "link_folder", "egress", "github_issues", "github_pulls", "branches", "delegate_issue"];
    let all: Vec<String> = groups().iter().map(|g| g.to_string()).collect();
    assert!(group("folder").is_none(), "a group of the channel's own alone isn't offered");
    for kind in [Kind::Work, Kind::Chat, Kind::Untrusted] {
        for tool in tools_for(&["one".to_string()], kind, &all) {
            assert!(!own.contains(&name_of(&tool)), "{kind:?} lists {}", name_of(&tool));
        }
    }
    for action in ["start_session", "stop_session", "extend_session", "message_session", "message_sessions"] {
        assert!(chat_request(action).is_none(), "{action} is the channel's");
    }
    // The chat's `move_issues` is served here (ORR-1100), so it's listed here.
    assert!(tools_for(&["one".to_string()], Kind::Chat, &all).iter().any(|t| name_of(t) == "move_issues"));
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
