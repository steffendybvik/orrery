// The tests of routes/settings.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};
use sqlx::Row;

async fn changes(api: &TestApi, kind: &str) -> i64 {
    sqlx::query(&crate::db::sql("SELECT CAST(count(*) AS BIGINT) AS n FROM changes WHERE kind = ?")).bind(kind).fetch_one(&api.app.pool).await.unwrap().get("n")
}

async fn refused(api: &TestApi, body: Value) -> Vec<String> {
    let reply = api.patch("/api/settings", body.clone()).send().await;
    assert_eq!(reply.status, 400, "{body} should be refused: {}", reply.body);
    reply.problems()
}

#[tokio::test]
async fn a_fresh_orrery_has_every_setting_at_its_default() {
    let api = TestApi::new().await;
    let reply = api.get("/api/settings").send().await;
    assert_eq!(reply.status, 200);
    let s = &reply.body;
    assert!(s["id"].as_str().is_some_and(|id| id.starts_with("orr_") && id.len() == 10), "{}", s["id"]);
    assert_eq!(s["tint"], Value::Null);
    assert_eq!(s["focus_prompt"], Value::Null);
    assert_eq!(s["milestone_prompt"], Value::Null);
    assert_eq!(s["instructions"], json!([]));
    assert_eq!(s["handle"], Value::Null);
    assert_eq!(s["tracker"], Value::Null);
    assert_eq!(s["starts"], Value::Null);
    assert_eq!(s["terminal"], "terminal");
    assert_eq!(s["agent"], "claude");
    assert_eq!(s["restrict_proposals"], true);
    assert_eq!(s["advanced"], true);
    assert_eq!(s["count_use"], false);
    assert_eq!(s["starred"], json!([]));
    assert_eq!(s["hidden"], json!([]));
    assert!(s["statuses"].as_array().is_some_and(|l| !l.is_empty()), "the statuses are in them: {}", s["statuses"]);
    let kinds = s["work_kinds"].as_array().unwrap();
    assert_eq!(kinds.first().unwrap()["id"], "security");
    assert_eq!(kinds.len(), 10);
}

#[tokio::test]
async fn the_orrerys_id_is_made_once_and_kept() {
    let api = TestApi::new().await;
    let first = api.get("/api/settings").send().await.body["id"].clone();
    let second = api.get("/api/settings").send().await.body["id"].clone();
    assert_eq!(first, second);
    let patched = api.patch("/api/settings", json!({"tint": "blue"})).send().await;
    assert_eq!(patched.body["id"], first);
}

#[tokio::test]
async fn a_patch_changes_only_what_it_sends_and_says_so() {
    let api = TestApi::new().await;
    let before = changes(&api, "settings").await;
    let reply = api.patch("/api/settings", json!({"tint": "#3b82f6", "terminal": "ghostty", "agent": "other", "count_use": true})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["tint"], "#3b82f6");
    assert_eq!(reply.body["terminal"], "ghostty");
    assert_eq!(reply.body["count_use"], true);
    assert_eq!(reply.body["agent"], "other");
    assert_eq!(reply.body["advanced"], true, "what wasn't sent stays");
    assert_eq!(reply.header("orrery-settings"), Some("1"));
    assert_eq!(reply.header("orrery-settings-keys"), Some("agent, count%5Fuse, terminal, tint"), "the keys sent, sorted and percent-encoded");
    assert_eq!(reply.header("orrery-changed"), None, "no project changes unless starts does");
    assert_eq!(changes(&api, "settings").await, before + 1, "the settings stream is told");
    let read = api.get("/api/settings").send().await.body;
    assert_eq!((read["tint"].as_str(), read["terminal"].as_str(), read["count_use"].as_bool()), (Some("#3b82f6"), Some("ghostty"), Some(true)));
}

#[tokio::test]
async fn null_puts_a_setting_back_to_its_default() {
    let api = TestApi::new().await;
    api.patch("/api/settings", json!({"terminal": "warp", "tint": "rose", "handle": "Ada"})).send().await;
    let reply = api.patch("/api/settings", json!({"terminal": null, "tint": null, "handle": null})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["terminal"], "terminal");
    assert_eq!(reply.body["tint"], Value::Null);
    assert_eq!(reply.body["handle"], Value::Null);
    assert_eq!(reply.header("orrery-settings-keys"), Some("handle, terminal, tint"), "keys sent as null count too");
}

#[tokio::test]
async fn a_session_cant_change_the_settings() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/settings", json!({"tint": "blue"})).by_agent("claude").send().await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.body["data"]["permission"], "settings.write");
    assert_eq!(reply.header("orrery-settings"), None);
    assert_eq!(api.get("/api/settings").send().await.body["tint"], Value::Null, "nothing changed");
}

#[tokio::test]
async fn a_session_can_read_the_settings() {
    let api = TestApi::new().await;
    let reply = api.get("/api/settings").by_agent("claude").send().await;
    assert_eq!(reply.status, 200);
    assert!(reply.body["id"].is_string());
}

#[tokio::test]
async fn a_setting_it_doesnt_know_is_refused() {
    let api = TestApi::new().await;
    let said = refused(&api, json!({"colour": "blue"})).await;
    assert_eq!(said.len(), 1);
    assert!(said[0].starts_with("unknown field \"colour\"; this takes tint, focus_prompt"), "{said:?}");
}

#[tokio::test]
async fn a_body_that_isnt_an_object_is_refused() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/settings", json!(["tint"])).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "The body should be a JSON object");
}

#[tokio::test]
async fn every_problem_is_said_at_once_and_nothing_is_kept() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/settings", json!({"tint": "red", "terminal": "kitty", "agent": "codex", "advanced": "yes"})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "4 problems in the body");
    assert_eq!(
        reply.problems(),
        [
            "\"tint\" is \"red\"; use slate, blue, teal, green, amber, rose, violet or a colour like #3b82f6",
            "\"terminal\" is \"kitty\", not one of terminal, iterm, warp, ghostty (or null)",
            "\"agent\" is \"codex\", not one of claude, other (or null)",
            "\"advanced\" should be a boolean, not \"yes\"",
        ]
    );
    assert_eq!(api.get("/api/settings").send().await.body["terminal"], "terminal");
}

#[tokio::test]
async fn a_tint_is_a_named_one_or_a_hex_colour() {
    let api = TestApi::new().await;
    for tint in ["slate", "violet", "#A0b1C2"] {
        let reply = api.patch("/api/settings", json!({"tint": tint})).send().await;
        assert_eq!(reply.status, 200, "{tint}: {}", reply.body);
        assert_eq!(reply.body["tint"], tint);
    }
    for tint in ["#abc", "Blue", "#gggggg"] {
        refused(&api, json!({"tint": tint})).await;
    }
}

#[tokio::test]
async fn the_booleans_cant_be_null() {
    let api = TestApi::new().await;
    let said = refused(&api, json!({"restrict_proposals": null, "advanced": null, "count_use": null})).await;
    assert_eq!(said, ["\"restrict_proposals\" can't be null", "\"advanced\" can't be null", "\"count_use\" can't be null"]);
    let reply = api.patch("/api/settings", json!({"restrict_proposals": false, "advanced": false})).send().await;
    assert_eq!((reply.body["restrict_proposals"].as_bool(), reply.body["advanced"].as_bool()), (Some(false), Some(false)));
}

#[tokio::test]
async fn a_string_setting_must_be_a_string() {
    let api = TestApi::new().await;
    let said = refused(&api, json!({"focus_prompt": 3, "handle": true})).await;
    assert_eq!(said, ["\"focus_prompt\" should be a string, not 3", "\"handle\" should be a string, not true"]);
}

#[tokio::test]
async fn an_empty_prompt_is_none_and_a_prompt_is_trimmed() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/settings", json!({"focus_prompt": "  Work on {issue}  ", "milestone_prompt": "   "})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["focus_prompt"], "Work on {issue}");
    assert_eq!(reply.body["milestone_prompt"], Value::Null);
}

#[tokio::test]
async fn a_handle_is_kept_lowercase_and_must_look_like_a_login() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/settings", json!({"handle": "Ada.Lovelace_1"})).send().await;
    assert_eq!(reply.body["handle"], "ada.lovelace_1");
    let said = refused(&api, json!({"handle": "-ada"})).await;
    assert!(said[0].starts_with("\"handle\" is \"-ada\"; use letters, digits"), "{said:?}");
    refused(&api, json!({"handle": "a".repeat(40)})).await;
}

#[tokio::test]
async fn a_tracker_is_a_web_address_with_the_id_in_it() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/settings", json!({"tracker": "https://tracker.example.com/issue/{id}"})).send().await;
    assert_eq!(reply.body["tracker"], "https://tracker.example.com/issue/{id}");
    for bad in ["https://tracker.example.com/issue/", "ftp://x/{id}", "tracker {id}"] {
        let said = refused(&api, json!({"tracker": bad})).await;
        assert!(said[0].contains("use the web address of a task with {id}"), "{bad}: {said:?}");
    }
}

#[tokio::test]
async fn each_terminal_it_knows_is_taken() {
    let api = TestApi::new().await;
    for terminal in ["terminal", "iterm", "warp", "ghostty"] {
        assert_eq!(api.patch("/api/settings", json!({"terminal": terminal})).send().await.body["terminal"], terminal);
    }
}

#[tokio::test]
async fn instructions_get_ids_are_trimmed_and_are_on_unless_said() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/settings", json!({"instructions": [{"text": "  Be brief "}, {"id": "keep", "text": "Test it", "on": false}]})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let lines = reply.body["instructions"].as_array().unwrap();
    assert_eq!(lines[0]["text"], "Be brief");
    assert_eq!(lines[0]["on"], true);
    assert!(lines[0]["id"].as_str().is_some_and(|id| id.len() == 8), "a new line gets an id: {}", lines[0]);
    assert_eq!(lines[1], json!({"id": "keep", "text": "Test it", "on": false}));
}

#[tokio::test]
async fn an_instruction_without_text_or_with_odd_fields_is_refused() {
    let api = TestApi::new().await;
    for bad in [json!([{"text": " "}]), json!([{"text": "x", "on": "yes"}]), json!([{"text": "x", "id": 4}]), json!("Be brief"), json!([{}])] {
        let said = refused(&api, json!({"instructions": bad})).await;
        assert!(said[0].starts_with("\"instructions\" should be a list of {text, on?, id?}"), "{said:?}");
    }
}

#[tokio::test]
async fn starred_and_hidden_are_trimmed_without_repeats_and_hidden_wins() {
    let api = TestApi::new().await;
    let reply = api.patch("/api/settings", json!({"starred": [" a ", "a", "b", "c"], "hidden": ["b", "b"]})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["starred"], json!(["a", "c"]), "a hidden project isn't starred");
    assert_eq!(reply.body["hidden"], json!(["b"]));
    let said = refused(&api, json!({"starred": ["a", ""], "hidden": [1]})).await;
    assert_eq!(said, ["\"starred\" should be a list of strings, not [\"a\",\"\"]", "\"hidden\" should be a list of strings, not [1]"]);
}

#[tokio::test]
async fn starts_is_kept_without_its_empty_parts_and_tells_every_project() {
    let api = TestApi::new().await;
    let a = api.project("Alpha").await;
    let b = api.project("Beta").await;
    let reply = api.patch("/api/settings", json!({"starts": {"limit": 3, "min": 1, "idle_minutes": null, "on_signal": true}})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["starts"], json!({"limit": 3, "min": 1}));
    let changed = reply.header("orrery-changed").unwrap();
    assert!(changed.contains(&a) && changed.contains(&b), "{changed}");
    let off = api.patch("/api/settings", json!({"starts": {"limit": 20, "minutes": 1440, "idle_minutes": 5, "on_signal": false}})).send().await;
    assert_eq!(off.body["starts"], json!({"limit": 20, "minutes": 1440, "idle_minutes": 5, "on_signal": false}));
    assert_eq!(api.get("/api/settings").send().await.body["starts"], off.body["starts"]);
    let none = api.patch("/api/settings", json!({"starts": null})).send().await;
    assert_eq!(none.body["starts"], Value::Null);
    assert!(none.header("orrery-changed").is_some(), "taking starts off tells the projects too");
}

#[tokio::test]
async fn starts_out_of_its_bounds_is_refused() {
    let api = TestApi::new().await;
    for bad in [
        json!({"limit": 0}),
        json!({"limit": 21}),
        json!({"limit": 2.5}),
        json!({"limit": 2, "min": 3}),
        json!({"limit": 2, "minutes": 1441}),
        json!({"limit": 2, "minutes": 0}),
        json!({"limit": 2, "idle_minutes": 0.5}),
        json!({"limit": 2, "on_signal": "no"}),
        json!({"limit": 2, "extra": 1}),
        json!({}),
        json!(5),
    ] {
        let said = refused(&api, json!({"starts": bad})).await;
        assert!(said[0].starts_with("\"starts\": should be {limit, min?, minutes?, idle_minutes?, on_signal?}"), "{bad}: {said:?}");
    }
}

#[tokio::test]
async fn work_kinds_are_kept_trimmed_with_their_labels_lowercase() {
    let api = TestApi::new().await;
    let kinds = json!([
        {"id": "bug", "name": " Bug ", "labels": ["Bug", "bug", "Defect "], "model": "opus", "effort": "high"},
        {"id": "other", "name": "Other", "labels": [], "model": "claude-sonnet-4-5[1m]", "effort": null},
    ]);
    let reply = api.patch("/api/settings", json!({"work_kinds": kinds})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(
        reply.body["work_kinds"],
        json!([
            {"id": "bug", "name": "Bug", "labels": ["bug", "defect"], "model": "opus", "effort": "high"},
            {"id": "other", "name": "Other", "labels": [], "model": "claude-sonnet-4-5[1m]"},
        ])
    );
    let reset = api.patch("/api/settings", json!({"work_kinds": null})).send().await;
    assert_eq!(reset.body["work_kinds"].as_array().unwrap().len(), 10, "null brings back the kinds orrery ships");
}

#[tokio::test]
async fn work_kinds_that_dont_hold_together_are_refused() {
    let api = TestApi::new().await;
    let kind = |id: &str, labels: Value| json!({"id": id, "name": "K", "labels": labels, "model": "best"});
    let cases = [
        (json!([]), "at least one kind"),
        (json!([kind("a", json!([])), kind("a", json!([]))]), "\"a\" is there twice"),
        (json!([kind("a", json!(["x"])), kind("b", json!(["X"]))]), "label \"x\" is in both a and b"),
        (json!([kind("Not A Slug", json!([]))]), "each needs an id of lowercase letters"),
        (json!([{"id": "a", "name": " ", "labels": [], "model": "best"}]), "a needs a name"),
        (json!([kind("a", json!([""]))]), "a's labels should be a list of labels"),
        (json!([{"id": "a", "name": "A", "labels": [], "model": "gpt"}]), "a's model should be best, opus"),
        (json!([{"id": "a", "name": "A", "labels": [], "model": "best", "effort": "huge"}]), "a's effort should be one of low"),
        (json!([{"id": "a", "name": "A", "labels": [], "model": "best", "colour": 1}]), "colour isn't a kind's"),
    ];
    for (kinds, why) in cases {
        let said = refused(&api, json!({"work_kinds": kinds})).await;
        assert!(said[0].starts_with("\"work_kinds\": should be a list of {id, name, labels, model, effort?}"), "{said:?}");
        assert!(said[0].contains(why), "{why}: {said:?}");
    }
}
