// The tests of routes/presets.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};

async fn make(api: &TestApi, path: &str, body: Value) -> Value {
    let reply = api.post(path, body).send().await;
    assert_eq!(reply.status, 201, "making a preset: {}", reply.body);
    reply.body
}

fn names(list: &Value) -> Vec<&str> {
    list.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect()
}

/// The presets orrery ships, put back on an orrery that has none.
async fn restored(api: &TestApi) -> Value {
    let reply = api.post("/api/presets/defaults", json!({})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.body
}

fn shipped<'v>(list: &'v Value, key: &str) -> &'v Value {
    list.as_array().unwrap().iter().find(|p| p["default"]["key"] == key).unwrap()
}

#[tokio::test]
async fn the_orrery_has_no_presets_until_theyre_made() {
    let api = TestApi::new().await;
    let reply = api.get("/api/presets").send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, json!([]));
}

#[tokio::test]
async fn a_new_preset_is_the_orrerys_trimmed() {
    let api = TestApi::new().await;
    let reply = api.post("/api/presets", json!({"name": "  Careful ", "text": " Run the tests first. ", "icon": "shield-check", "color": "rose"})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.header("orrery-changed"), None, "a preset wakes nothing");
    let preset = &reply.body;
    assert!(preset["id"].is_i64());
    assert_eq!(preset["project"], Value::Null);
    assert_eq!(preset["name"], "Careful");
    assert_eq!(preset["text"], "Run the tests first.");
    assert_eq!(preset["icon"], "shield-check");
    assert_eq!(preset["color"], "rose");
    assert!(preset.get("default").is_none(), "it isn't one orrery ships");
    assert_eq!(api.get("/api/presets").send().await.body, json!([preset]));
}

#[tokio::test]
async fn the_orrerys_presets_are_listed_by_name() {
    let api = TestApi::new().await;
    for name in ["beta", "Alpha", "gamma"] {
        make(&api, "/api/presets", json!({"name": name, "text": "x"})).await;
    }
    assert_eq!(names(&api.get("/api/presets").send().await.body), ["Alpha", "beta", "gamma"]);
}

#[tokio::test]
async fn a_projects_presets_are_the_orrerys_then_its_own() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let squares = api.project("Squares").await;
    make(&api, "/api/presets", json!({"name": "Zeta", "text": "x"})).await;
    let own = make(&api, &format!("/api/projects/{primes}/presets"), json!({"name": "Alpha", "text": "y"})).await;
    assert_eq!(own["project"], json!(primes));
    make(&api, &format!("/api/projects/{squares}/presets"), json!({"name": "Squares only", "text": "z"})).await;
    let reply = api.get(&format!("/api/projects/{primes}/presets")).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(names(&reply.body), ["Zeta", "Alpha"]);
    assert_eq!(names(&api.get("/api/presets").send().await.body), ["Zeta"], "the orrery's alone");
}

#[tokio::test]
async fn a_project_it_doesnt_have_is_a_404() {
    let api = TestApi::new().await;
    let listed = api.get("/api/projects/nope/presets").send().await;
    assert_eq!(listed.status, 404);
    assert_eq!(listed.body["message"], "No project \"nope\"");
    let made = api.post("/api/projects/nope/presets", json!({"name": "A", "text": "B"})).send().await;
    assert_eq!(made.status, 404);
}

#[tokio::test]
async fn a_preset_needs_a_name_and_text() {
    let api = TestApi::new().await;
    let reply = api.post("/api/presets", json!({"icon": "Bad Icon", "color": "red", "badge": 1})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "5 problems in the body");
    assert_eq!(
        reply.body["data"]["problems"],
        json!([
            "unknown field \"badge\"; this takes name, text, icon, color",
            "missing \"name\"",
            "missing \"text\"",
            "\"icon\" is \"Bad Icon\"; use a Heroicon's name, e.g. shield-check",
            "\"color\" is \"red\"; use slate, blue, teal, green, amber, rose, violet or a colour like #3b82f6",
        ])
    );
    for (body, said) in [
        (json!({"name": " ", "text": "x"}), "\"name\" can't be empty"),
        (json!({"name": null, "text": "x"}), "\"name\" can't be null"),
        (json!({"name": 3, "text": "x"}), "\"name\" should be a string, not 3"),
    ] {
        let reply = api.post("/api/presets", body).send().await;
        assert_eq!((reply.status.as_u16(), reply.body["message"].as_str()), (400, Some(said)));
    }
    assert_eq!(api.post("/api/presets", json!("Careful")).send().await.body["message"], "The body should be a JSON object");
    assert_eq!(api.get("/api/presets").send().await.body, json!([]), "nothing made");
}

#[tokio::test]
async fn a_session_cant_write_presets() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let preset = make(&api, "/api/presets", json!({"name": "A", "text": "B"})).await;
    let id = preset["id"].as_i64().unwrap();
    for reply in [
        api.post("/api/presets", json!({"name": "A", "text": "B"})).by_agent("claude").send().await,
        api.post(&format!("/api/projects/{project}/presets"), json!({"name": "A", "text": "B"})).by_agent("claude").send().await,
        api.patch(&format!("/api/presets/{id}"), json!({"name": "C"})).by_agent("claude").send().await,
        api.delete(&format!("/api/presets/{id}")).by_agent("claude").send().await,
        api.post(&format!("/api/presets/{id}/reset"), json!({})).by_agent("claude").send().await,
        api.post("/api/presets/defaults", json!({})).by_agent("claude").send().await,
    ] {
        assert_eq!(reply.status, 403, "{}", reply.body);
        assert_eq!(reply.body["data"]["permission"], "presets.write");
    }
    assert_eq!(api.get("/api/presets").send().await.body, json!([preset]), "nothing changed");
    assert_eq!(api.get("/api/presets").by_agent("claude").send().await.status, 200, "a session reads them");
}

#[tokio::test]
async fn a_change_sets_only_what_it_sends_and_null_takes_the_badge_off() {
    let api = TestApi::new().await;
    let preset = make(&api, "/api/presets", json!({"name": "A", "text": "B", "icon": "eye", "color": "#3b82f6"})).await;
    let id = preset["id"].as_i64().unwrap();
    let reply = api.patch(&format!("/api/presets/{id}"), json!({"name": " Renamed ", "icon": null})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["name"], "Renamed");
    assert_eq!(reply.body["text"], "B");
    assert_eq!(reply.body["icon"], Value::Null);
    assert_eq!(reply.body["color"], "#3b82f6");
    assert_eq!(reply.body["created_at"], preset["created_at"]);
    assert_eq!(api.get("/api/presets").send().await.body[0], reply.body);
    let blank = api.patch(&format!("/api/presets/{id}"), json!({"text": "  "})).send().await;
    assert_eq!(blank.status, 400);
    assert_eq!(blank.body["message"], "\"text\" can't be empty");
}

#[tokio::test]
async fn a_preset_is_named_by_its_number_or_its_full_id() {
    let api = TestApi::new().await;
    let id = make(&api, "/api/presets", json!({"name": "A", "text": "B"})).await["id"].as_i64().unwrap();
    let uid: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'uid'").fetch_one(&api.app.pool).await.unwrap();
    let uid: String = serde_json::from_str(&uid).unwrap();
    let reply = api.patch(&format!("/api/presets/pst-{id}-{uid}"), json!({"name": "Full"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["name"], "Full");
    let other = api.patch(&format!("/api/presets/pst-{id}-zzzzzzzz"), json!({"name": "X"})).send().await;
    assert_eq!(other.status, 404);
    assert_eq!(other.body["message"], format!("No preset pst-{id}-zzzzzzzz"));
}

#[tokio::test]
async fn a_preset_it_doesnt_have_is_a_404() {
    let api = TestApi::new().await;
    let patched = api.patch("/api/presets/99", json!({"name": "X"})).send().await;
    assert_eq!(patched.status, 404);
    assert_eq!(patched.body["message"], "No preset 99");
    assert_eq!(api.delete("/api/presets/99").send().await.status, 404);
    assert_eq!(api.post("/api/presets/99/reset", json!({})).send().await.status, 404);
    assert_eq!(api.delete("/api/presets/abc").send().await.status, 404);
}

#[tokio::test]
async fn a_deleted_preset_is_gone() {
    let api = TestApi::new().await;
    let id = make(&api, "/api/presets", json!({"name": "A", "text": "B"})).await["id"].as_i64().unwrap();
    make(&api, "/api/presets", json!({"name": "Kept", "text": "B"})).await;
    let reply = api.delete(&format!("/api/presets/{id}")).send().await;
    assert_eq!(reply.status, 204);
    assert_eq!(names(&api.get("/api/presets").send().await.body), ["Kept"]);
    assert_eq!(api.delete(&format!("/api/presets/{id}")).send().await.status, 404);
}

#[tokio::test]
async fn restoring_the_defaults_adds_those_orrery_ships_once() {
    let api = TestApi::new().await;
    let restored = restored(&api).await;
    assert_eq!(restored.as_array().unwrap().len(), 4);
    let release = shipped(&restored, "release");
    assert_eq!(release["name"], "Release");
    assert_eq!(release["icon"], "rocket-launch");
    assert_eq!(release["color"], "violet");
    assert_eq!(release["default"], json!({"key": "release", "changed": false}));
    assert_eq!(self::restored(&api).await, json!([]), "none are missing now");
    assert_eq!(api.get("/api/presets").send().await.body.as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn restoring_brings_back_only_the_defaults_removed() {
    let api = TestApi::new().await;
    let all = restored(&api).await;
    let review = shipped(&all, "review")["id"].as_i64().unwrap();
    api.delete(&format!("/api/presets/{review}")).send().await;
    let again = restored(&api).await;
    assert_eq!(again.as_array().unwrap().len(), 1);
    assert_eq!(again[0]["default"]["key"], "review");
}

#[tokio::test]
async fn a_changed_default_says_so_until_its_reset() {
    let api = TestApi::new().await;
    let all = restored(&api).await;
    let release = shipped(&all, "release").clone();
    let id = release["id"].as_i64().unwrap();
    let changed = api.patch(&format!("/api/presets/{id}"), json!({"text": "My own release steps", "color": null})).send().await;
    assert_eq!(changed.body["default"], json!({"key": "release", "changed": true}));
    let reply = api.post(&format!("/api/presets/{id}/reset"), json!({})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["text"], release["text"]);
    assert_eq!(reply.body["color"], "violet");
    assert_eq!(reply.body["default"], json!({"key": "release", "changed": false}));
}

#[tokio::test]
async fn a_preset_orrery_doesnt_ship_cant_be_reset() {
    let api = TestApi::new().await;
    let id = make(&api, "/api/presets", json!({"name": "Mine", "text": "B"})).await["id"].as_i64().unwrap();
    let reply = api.post(&format!("/api/presets/{id}/reset"), json!({})).send().await;
    assert_eq!(reply.status, 409);
    assert_eq!(reply.body["message"], format!("Resetting preset {id}: Mine isn't one orrery ships, so it has no default"));
}

async fn seeded(api: &TestApi) -> i64 {
    let reply = api.post("/api/presets/seed", json!({})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.body["added"].as_i64().unwrap()
}

#[tokio::test]
async fn seeding_adds_those_orrery_ships_once_and_not_one_the_owner_removed() {
    let api = TestApi::new().await;
    assert_eq!(seeded(&api).await, 4);
    assert_eq!(seeded(&api).await, 0, "each is seeded once");
    let all = api.get("/api/presets").send().await.body;
    assert_eq!(all.as_array().unwrap().len(), 4);
    let review = shipped(&all, "review")["id"].as_i64().unwrap();
    assert_eq!(api.delete(&format!("/api/presets/{review}")).send().await.status, 204);
    assert_eq!(seeded(&api).await, 0);
    assert_eq!(api.get("/api/presets").send().await.body.as_array().unwrap().len(), 3, "a removed one stays removed");
    assert_eq!(api.count("SELECT COUNT(*) FROM preset_defaults").await, 4);
}

#[tokio::test]
async fn seeding_brings_an_old_shipped_text_up_to_date_and_keeps_the_owners() {
    let api = TestApi::new().await;
    seeded(&api).await;
    let shipped_json: Value = serde_json::from_str(include_str!("../../../web/shared/presets.json")).unwrap();
    let release = shipped_json.as_array().unwrap().iter().find(|p| p["key"] == "release").unwrap();
    let old = release["was"][0].as_str().unwrap();
    let all = api.get("/api/presets").send().await.body;
    let release_id = shipped(&all, "release")["id"].as_i64().unwrap();
    let review_id = shipped(&all, "review")["id"].as_i64().unwrap();
    // The id goes in as a number: Postgres has no `integer = text` (ORR-1136).
    api.run(&format!("UPDATE presets SET text = ? WHERE id = {release_id}"), &[old]).await;
    assert_eq!(api.patch(&format!("/api/presets/{review_id}"), json!({"text": "Mine"})).send().await.status, 200);
    seeded(&api).await;
    let all = api.get("/api/presets").send().await.body;
    assert_eq!(shipped(&all, "release")["text"], release["text"]);
    assert_eq!(shipped(&all, "review")["text"], "Mine");
}

#[tokio::test]
async fn only_the_local_app_seeds_them() {
    let api = TestApi::new().await;
    let reply = api.post("/api/presets/seed", json!({})).header("orrery-came", "loopback").send().await;
    assert_eq!(reply.status, 403, "{}", reply.body);
    assert_eq!(api.count("SELECT COUNT(*) FROM presets").await, 0);
}

/// A preset is its workspace's (ORR-1107): the workspace's own are listed in it alone, a project's own goes with its
/// project's workspace, and another workspace's is a 404.
#[tokio::test]
async fn a_preset_is_its_workspaces() {
    let api = TestApi::new().await;
    api.team().await;
    let primes = api.project("Primes").await;
    let rockets = api.acme(&["steffen"]).await;
    let ours = make(&api, "/api/presets", json!({"name": "Careful", "text": "Go slowly."})).await;
    let theirs = api.post("/api/presets", json!({"name": "Launch", "text": "Count down."})).header("orrery-workspace", "acme").send().await;
    assert_eq!(theirs.status, 201, "{}", theirs.body);
    make(&api, &format!("/api/projects/{rockets}/presets"), json!({"name": "Fuel", "text": "Check it."})).await;

    assert_eq!(names(&api.get("/api/presets").send().await.body), ["Careful"]);
    assert_eq!(names(&api.get("/api/presets").header("orrery-workspace", "acme").send().await.body), ["Launch"]);
    assert_eq!(names(&api.get(&format!("/api/projects/{primes}/presets")).send().await.body), ["Careful"]);
    assert_eq!(names(&api.get(&format!("/api/projects/{rockets}/presets")).send().await.body), ["Launch", "Fuel"]);

    let id = theirs.body["id"].as_i64().unwrap();
    assert_eq!(api.delete(&format!("/api/presets/{id}")).send().await.status, 404, "from default, Acme's isn't there");
    assert_eq!(api.delete(&format!("/api/presets/{id}")).header("orrery-workspace", "acme").send().await.status, 204);
    let ours = ours["id"].as_i64().unwrap();
    assert_eq!(api.patch(&format!("/api/presets/{ours}"), json!({"name": "Slow"})).header("orrery-workspace", "acme").send().await.status, 404);
}
