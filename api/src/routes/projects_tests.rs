// The tests of routes/projects.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{ids, TestApi};
use serde_json::{json, Value};
use sqlx::Row;

async fn make(api: &TestApi, body: Value) -> Value {
    let reply = api.post("/api/projects", body).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    reply.body
}

/// Every issue on a project's board, at any depth, by id.
fn issue_ids(project: &Value) -> Vec<String> {
    fn walk(out: &mut Vec<String>, tasks: &Value) {
        for task in tasks.as_array().into_iter().flatten() {
            out.push(task["id"].as_str().unwrap_or_default().to_string());
            walk(out, &task["tasks"]);
        }
    }
    let mut out = vec![];
    for milestone in project["board"]["milestones"].as_array().into_iter().flatten() {
        walk(&mut out, &milestone["tasks"]);
    }
    out
}

#[tokio::test]
async fn a_new_project_takes_its_id_and_key_from_its_name() {
    let api = TestApi::new().await;
    let before: i64 = sqlx::query("SELECT count(*) AS n FROM changes").fetch_one(&api.app.pool).await.unwrap().get("n");
    let reply = api.post("/api/projects", json!({"name": "  Prime Numbers ", "description": "Sieves."})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let body = &reply.body;
    assert_eq!(body["id"], "prime-numbers");
    assert_eq!(body["name"], "Prime Numbers");
    assert_eq!(body["key"], "PRI");
    assert_eq!(body["description"], "Sieves.");
    assert_eq!(body["release_mode"], "none");
    assert_eq!(body["created_by"], "owner");
    assert_eq!(body["protected"], true);
    assert_eq!(body["docs"], json!([]));
    assert_eq!(body["doc_sections"], json!([]));
    assert_eq!(body["releases"], json!([]));
    assert_eq!(body["instructions"], json!([]));
    assert!(body["board"]["milestones"].is_array() && body["board"]["counts"].is_object(), "{body}");
    assert!(body["uid"].as_str().is_some_and(|u| !u.is_empty()));
    assert_eq!(reply.changed(), ["prime-numbers"], "each project in it percent-encoded");
    assert_eq!(reply.header("orrery-changed"), Some("prime%2Dnumbers"));
    let rows = sqlx::query(&crate::db::sql("SELECT kind, project FROM changes WHERE id > ? ORDER BY id")).bind(before).fetch_all(&api.app.pool).await.unwrap();
    let rows: Vec<(String, Option<String>)> = rows.iter().map(|r| (r.get("kind"), r.get("project"))).collect();
    assert_eq!(rows, [("project.changed".to_string(), Some("prime-numbers".to_string()))]);
    assert_eq!(api.get("/api/projects/prime-numbers").send().await.body, reply.body);
}

#[tokio::test]
async fn whoever_makes_a_project_holds_it() {
    let api = TestApi::new().await;
    for (id, role) in [("owner", "owner"), ("ann", "member")] {
        sqlx::query(&crate::db::sql("INSERT INTO people (id, name, role, created_at) VALUES (?, ?, ?, ?)"))
            .bind(id)
            .bind(id)
            .bind(role)
            .bind("2026-11-07T00:00:00.000Z")
            .execute(&api.app.pool)
            .await
            .unwrap();
    }
    let holders = |project: &'static str| {
        let pool = api.app.pool.clone();
        async move {
            let rows = sqlx::query(&crate::db::sql("SELECT person, role FROM project_members WHERE project = ?")).bind(project).fetch_all(&pool).await.unwrap();
            rows.iter().map(|r| (r.get::<String, _>("person"), r.get::<String, _>("role"))).collect::<Vec<_>>()
        }
    };
    make(&api, json!({"name": "Mine"})).await;
    assert_eq!(holders("mine").await, [("owner".to_string(), "owner".to_string())]);
    let theirs =
        api.post("/api/projects", json!({"name": "Hers"})).by_agent("ann").header("orrery-who", "browser").header("orrery-who-person", "ann").send().await;
    assert_eq!(theirs.status, 201, "{}", theirs.body);
    assert_eq!(holders("hers").await, [("ann".to_string(), "owner".to_string())], "the person asking holds it");
}

#[tokio::test]
async fn a_project_takes_the_id_and_key_it_is_given() {
    let api = TestApi::new().await;
    let made = make(
        &api,
        json!({"name": "Shop", "id": "store", "key": "SHP", "icon": "shopping-cart", "icon_color": "#3b82f6", "repo": "https://github.com/you/shop"}),
    )
    .await;
    assert_eq!(made["id"], "store");
    assert_eq!(made["key"], "SHP");
    assert_eq!(made["icon"], "shopping-cart");
    assert_eq!(made["repo"], "https://github.com/you/shop");
    // A key the other ids start with takes a fourth letter.
    assert_eq!(make(&api, json!({"name": "Epcot"})).await["key"], "EPCO");
}

#[tokio::test]
async fn a_bad_or_taken_project_is_refused() {
    let api = TestApi::new().await;
    let missing = api.post("/api/projects", json!({})).send().await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["data"]["problems"], json!(["missing \"name\""]));
    let wrong = api
        .post("/api/projects", json!({"name": "Shop", "key": "gre", "icon_color": "red", "repo": "ftp://x", "owner": "me", "release_mode": "lots"}))
        .send()
        .await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.body["data"]["problems"].as_array().unwrap().len(), 5, "{}", wrong.body);
    assert_eq!(api.post("/api/projects", json!({"name": "!!!"})).send().await.status, 400, "no id to make");
    assert_eq!(api.post("/api/projects", json!({"name": "Mills", "key": "MLS"})).send().await.status, 400, "a reserved key");
    make(&api, json!({"name": "Shop"})).await;
    assert_eq!(api.post("/api/projects", json!({"name": "Shop"})).send().await.status, 409);
    assert_eq!(api.get("/api/projects").send().await.body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn only_the_owner_says_what_sessions_are_told() {
    let api = TestApi::new().await;
    let refused = api.post("/api/projects", json!({"name": "Shop", "focus_prompt": "Hurry."})).by_agent("claude").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(refused.body["data"]["permission"], "prompts.write");
    let theirs = api.post("/api/projects", json!({"name": "Shop"})).by_agent("claude").send().await;
    assert_eq!(theirs.status, 201, "{}", theirs.body);
    assert_eq!(theirs.body["protected"], false);
    assert_eq!(theirs.body["created_by"], "claude");
    for body in [json!({"instructions": [{"text": "Be kind"}]}), json!({"muted": ["x"]}), json!({"milestone_prompt": "x"})] {
        let reply = api.patch("/api/projects/shop", body.clone()).by_agent("claude").send().await;
        assert_eq!(reply.status, 403, "{body}: {}", reply.body);
    }
    assert_eq!(api.patch("/api/projects/shop", json!({"description": "Fine."})).by_agent("claude").send().await.status, 200);
}

#[tokio::test]
async fn the_owner_s_instructions_and_mutes_are_kept_tidy() {
    let api = TestApi::new().await;
    make(&api, json!({"name": "Shop"})).await;
    let reply = api
        .patch(
            "/api/projects/shop",
            json!({"instructions": [{"text": "  Be kind  "}, {"id": "x1", "text": "Test", "on": false}], "muted": ["a", " a ", "b"], "focus_prompt": "   "}),
        )
        .send()
        .await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let lines = reply.body["instructions"].as_array().unwrap();
    assert_eq!(lines[0]["text"], "Be kind");
    assert_eq!(lines[0]["on"], true);
    assert!(lines[0]["id"].as_str().is_some_and(|id| !id.is_empty()), "a line gets an id");
    assert_eq!(lines[1], json!({"id": "x1", "text": "Test", "on": false}));
    assert_eq!(reply.body["muted"], json!(["a", "b"]));
    assert!(reply.body.get("focus_prompt").is_none(), "an empty template is the orrery's: {}", reply.body);
    let bad = api.patch("/api/projects/shop", json!({"instructions": [{"text": " "}], "muted": [1]})).send().await;
    assert_eq!(bad.status, 400);
    assert_eq!(bad.body["data"]["problems"].as_array().unwrap().len(), 2, "{}", bad.body);
}

#[tokio::test]
async fn the_projects_are_listed_by_name_with_their_counts() {
    let api = TestApi::new().await;
    let zebra = api.project("zebra").await;
    let apple = api.project("Apple").await;
    api.post(&format!("/api/projects/{zebra}/milestones"), json!({"title": "One"})).send().await;
    api.issue(&zebra, json!({"title": "Stripe"})).await;
    let listed = api.get("/api/projects").send().await;
    assert_eq!(listed.status, 200);
    let list = listed.body.as_array().unwrap();
    assert_eq!(list.iter().map(|p| p["id"].as_str().unwrap()).collect::<Vec<_>>(), [apple.as_str(), zebra.as_str()]);
    assert!(list[1].get("board").is_none(), "a listed project has its counts, not its board");
    assert_eq!(list[1]["milestones"], 1);
    assert!(list[1]["counts"].is_object() && list[1]["kinds"].is_object(), "{}", list[1]);
    assert_eq!(list[1]["counts"].as_object().unwrap().values().filter_map(Value::as_i64).sum::<i64>(), 1, "{}", list[1]["counts"]);
}

#[tokio::test]
async fn a_project_is_read_with_its_board_trimmed_as_asked() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let open = api.issue(&project, json!({"title": "Open", "notes": "Some notes."})).await;
    let done = api.issue(&project, json!({"title": "Shut", "status": "done"})).await;
    assert_eq!(api.get("/api/projects/nope").send().await.status, 404);
    let whole = api.get(&format!("/api/projects/{project}")).send().await;
    assert_eq!(whole.status, 200);
    let ids = issue_ids(&whole.body);
    assert!(ids.contains(&open) && ids.contains(&done), "{}", whole.body);
    let without = api.get(&format!("/api/projects/{project}?notes=0&closed=0")).send().await.body;
    assert_eq!(issue_ids(&without), vec![open.clone()]);
    let text = without["board"].to_string();
    assert!(!text.contains("Some notes."), "{text}");
    assert!(whole.body["board"].to_string().contains("Some notes."));
}

#[tokio::test]
async fn a_project_s_fields_are_changed_and_its_id_is_not() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let reply = api.patch(&format!("/api/projects/{project}"), json!({"name": " Prime Sieve ", "key": "SIV", "description": null})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["name"], "Prime Sieve");
    assert_eq!(reply.body["key"], "SIV");
    assert_eq!(reply.body["id"], json!(project));
    assert_eq!(reply.changed(), vec![project.clone()]);
    assert_eq!(api.patch(&format!("/api/projects/{project}"), json!({"id": "other"})).send().await.status, 400);
    assert_eq!(api.patch(&format!("/api/projects/{project}"), json!({"name": null})).send().await.status, 400);
    assert_eq!(api.patch("/api/projects/nope", json!({"name": "x"})).send().await.status, 404);
}

#[tokio::test]
async fn a_project_takes_releases_only_from_one_with_its_own() {
    let api = TestApi::new().await;
    make(&api, json!({"name": "Source", "release_mode": "own"})).await;
    make(&api, json!({"name": "Plain"})).await;
    make(&api, json!({"name": "Drawing", "releases_from": "source"})).await;
    let path = "/api/projects/plain";
    for (body, why) in [
        (json!({"releases_from": "plain"}), "itself"),
        (json!({"releases_from": "nope"}), "a missing project"),
        (json!({"releases_from": "drawing"}), "one that shares another's"),
        (json!({"release_mode": "shared"}), "shared from nobody"),
        (json!({"release_mode": "own", "releases_from": "source"}), "own and another's"),
    ] {
        let reply = api.patch(path, body).send().await;
        assert_eq!(reply.status, 400, "{why}: {}", reply.body);
    }
    make(&api, json!({"name": "Bare"})).await;
    assert_eq!(api.patch(path, json!({"releases_from": "bare"})).send().await.status, 400, "one with no releases");
    let drawing = api.get("/api/projects/drawing").send().await.body;
    assert_eq!(drawing["release_mode"], "shared");
    assert_eq!(drawing["releases_from"], "source");
}

#[tokio::test]
async fn a_source_keeps_its_own_releases_while_one_draws_on_it_or_it_has_some() {
    let api = TestApi::new().await;
    make(&api, json!({"name": "Source", "release_mode": "own"})).await;
    make(&api, json!({"name": "Drawing", "releases_from": "source"})).await;
    let drawn = api.patch("/api/projects/source", json!({"release_mode": "none"})).send().await;
    assert_eq!(drawn.status, 409, "{}", drawn.body);
    // Leaving it says both changed: the old source counted its issues.
    let left = api.patch("/api/projects/drawing", json!({"release_mode": "own"})).send().await;
    assert_eq!(left.status, 200, "{}", left.body);
    assert_eq!(left.changed(), ["drawing", "source"]);
    assert!(left.body.get("releases_from").is_none(), "{}", left.body);
    api.post("/api/projects/source/releases", json!({"version": "1.0"})).send().await;
    let has = api.patch("/api/projects/source", json!({"release_mode": "none"})).send().await;
    assert_eq!(has.status, 409, "{}", has.body);
    assert!(has.body["message"].as_str().unwrap().contains("1.0"), "{}", has.body);
}

#[tokio::test]
async fn moving_to_another_source_lets_go_of_releases_it_does_not_have() {
    let api = TestApi::new().await;
    make(&api, json!({"name": "Source", "release_mode": "own"})).await;
    make(&api, json!({"name": "Other", "release_mode": "own"})).await;
    make(&api, json!({"name": "Drawing", "releases_from": "source"})).await;
    api.post("/api/projects/source/releases", json!({"version": "1.0"})).send().await;
    api.post("/api/projects/other/releases", json!({"version": "2.0"})).send().await;
    let issue = api.issue("drawing", json!({"title": "Teeth", "release": "1.0"})).await;
    let moved = api.patch("/api/projects/drawing", json!({"releases_from": "other"})).send().await;
    assert_eq!(moved.status, 200, "{}", moved.body);
    assert_eq!(moved.changed(), ["drawing", "source"]);
    let read = api.get(&format!("/api/projects/drawing/issues/{issue}")).send().await.body;
    assert!(read.get("release").is_none_or(Value::is_null), "{read}");
    assert_eq!(moved.body["releases"][0]["version"], "2.0");
}

#[tokio::test]
async fn a_board_is_exported_as_one_file_named_for_the_day() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    sqlx::query(&crate::db::sql("INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"))
        .bind("0123456789abcdef01234567")
        .bind("image/png")
        .bind("dot.png")
        .bind(3_i64)
        .bind(vec![1_u8, 2, 3])
        .bind("owner")
        .bind(1_i64)
        .bind("2026-11-07T00:00:00.000Z")
        .execute(&api.app.pool)
        .await
        .unwrap();
    api.post(&format!("/api/projects/{project}/docs"), json!({"title": "Plan", "body": "![dot](/api/uploads/0123456789abcdef01234567)"})).send().await;
    api.issue(&project, json!({"title": "Sieve", "status": "todo"})).await;
    let other = api.project("Gears").await;
    api.issue(&other, json!({"title": "Teeth"})).await;

    let reply = api.get(&format!("/api/projects/{project}/export")).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let day = reply.body["exported_at"].as_str().unwrap()[..10].to_string();
    assert_eq!(reply.header("content-disposition"), Some(format!("attachment; filename=\"{project}-{day}.orrery.json\"").as_str()));
    let body = &reply.body;
    assert_eq!(body["format"], "orrery-board");
    assert_eq!(body["format_version"], 1);
    assert_eq!(body["project"], json!(project));
    assert_eq!(body["tables"]["projects"][0]["id"], json!(project));
    assert_eq!(body["tables"]["issues"].as_array().unwrap().len(), 1, "only this board's issues");
    assert_eq!(body["tables"]["docs"][0]["id"], "plan");
    assert_eq!(body["statuses"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect::<Vec<_>>(), ["todo"], "only the statuses it uses");
    assert_eq!(body["uploads"].as_array().unwrap().len(), 1, "the images its text shows");
    assert_eq!(body["uploads"][0]["data"], "AQID", "an image's bytes go in base64");
    assert_eq!(api.get("/api/projects/nope/export").send().await.status, 404);
}

#[tokio::test]
async fn a_new_project_shares_releases_only_from_one_with_its_own() {
    let api = TestApi::new().await;
    make(&api, json!({"name": "Source", "release_mode": "own"})).await;
    make(&api, json!({"name": "Plain"})).await;
    for (body, why) in [
        (json!({"name": "A", "release_mode": "shared"}), "shared from nobody"),
        (json!({"name": "B", "releases_from": "plain"}), "one with none"),
        (json!({"name": "C", "releases_from": "nope"}), "a missing one"),
        (json!({"name": "D", "release_mode": "none", "releases_from": "source"}), "none and another's"),
    ] {
        let reply = api.post("/api/projects", body).send().await;
        assert_eq!(reply.status, 400, "{why}: {}", reply.body);
    }
    let shared = make(&api, json!({"name": "E", "release_mode": "shared", "releases_from": "source"})).await;
    assert_eq!(shared["releases_from"], "source");
    assert_eq!(api.get("/api/projects").send().await.body.as_array().unwrap().len(), 3);
}

fn roadmap() -> Value {
    json!({"milestones": [
        {"id": "first", "title": "First", "summary": "The start", "tasks": [
            {"id": "a", "title": "Plan", "status": "done", "labels": ["x"], "tasks": [{"id": "a1", "title": "Sketch", "status": "doing"}]},
            {"id": "b", "title": "Build", "status": "todo", "plan": "now", "priority": "P1", "notes": "Soon"},
        ]},
        {"id": "second", "title": "Second", "tasks": [{"id": "c", "title": "Ship"}]},
    ]})
}

#[tokio::test]
async fn a_roadmap_is_imported_with_the_projects_ids_and_the_files_as_aliases() {
    let api = TestApi::new().await;
    let project = api.project("Garden").await;
    let key = api.get(&format!("/api/projects/{project}")).send().await.body["key"].as_str().unwrap().to_string();
    let reply = api.post(&format!("/api/projects/{project}/import"), roadmap()).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.changed(), std::slice::from_ref(&project));
    let milestones = reply.body["board"]["milestones"].as_array().unwrap();
    assert_eq!(milestones.iter().map(|m| m["id"].as_str().unwrap()).collect::<Vec<_>>(), ["1", "2"]);
    assert_eq!(milestones[0]["summary"], "The start");
    assert_eq!(milestones[0]["aliases"], json!(["first"]));
    // In roadmap order, sub-issues right after their parent.
    assert_eq!(issue_ids(&reply.body), [format!("{key}-1"), format!("{key}-2"), format!("{key}-3"), format!("{key}-4")]);
    let plan = &milestones[0]["tasks"][0];
    assert_eq!(plan["status"], "done");
    assert_eq!(plan["labels"], json!(["x"]));
    assert_eq!(plan["aliases"], json!(["a"]));
    assert_eq!(plan["tasks"][0]["status"], "in-progress");
    assert_eq!(milestones[0]["tasks"][1]["status"], "todo");
    assert_eq!(milestones[0]["tasks"][1]["priority"], "P1");
    assert_eq!(milestones[1]["tasks"][0]["status"], "backlog", "todo without a plan is the backlog");
    // The file's ids still find them.
    let found = api.get(&format!("/api/projects/{project}/issues/b")).send().await;
    assert_eq!(found.body["id"], format!("{key}-3"), "{}", found.body);
    // The counters move on past what the import gave out.
    assert_eq!(api.issue(&project, json!({"title": "Next"})).await, format!("{key}-5"));
}

#[tokio::test]
async fn an_import_replaces_a_roadmap_only_when_asked() {
    let api = TestApi::new().await;
    let project = api.project("Orchard").await;
    let key = api.get(&format!("/api/projects/{project}")).send().await.body["key"].as_str().unwrap().to_string();
    let old = api.issue(&project, json!({"title": "Old"})).await;
    api.post(&format!("/api/projects/{project}/issues/{old}/comments"), json!({"body": "Gone soon"})).send().await;
    let refused = api.post(&format!("/api/projects/{project}/import"), roadmap()).send().await;
    assert_eq!(refused.status, 409, "{}", refused.body);
    // An agent can't take away what the owner made.
    let agent = api.post(&format!("/api/projects/{project}/import?replace=true"), roadmap()).by_agent("claude").send().await;
    assert_eq!(agent.status, 403, "{}", agent.body);
    assert!(agent.body["message"].as_str().unwrap().contains(&format!("Replacing {project}'s roadmap is the owner's call: {old}")), "{}", agent.body);
    let replaced = api.post(&format!("/api/projects/{project}/import?replace=true"), roadmap()).send().await;
    assert_eq!(replaced.status, 200, "{}", replaced.body);
    let ids = issue_ids(&replaced.body);
    assert_eq!(ids.len(), 4);
    assert!(!ids.contains(&format!("{key}-1")), "a number never comes to mean another issue: {ids:?}");
    let comments: i64 = sqlx::query(&crate::db::sql("SELECT CAST(COUNT(*) AS BIGINT) AS n FROM comments WHERE project = ?"))
        .bind(&project)
        .fetch_one(&api.app.pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(comments, 0);
}

#[tokio::test]
async fn a_file_that_isnt_a_roadmap_is_refused_with_each_problem() {
    let api = TestApi::new().await;
    let project = api.project("Meadow").await;
    let not = api.post(&format!("/api/projects/{project}/import"), json!([1])).send().await;
    assert_eq!(not.status, 400);
    assert_eq!(not.body["message"], "Not a roadmap");
    assert_eq!(not.body["data"]["problems"], json!(["the file: should be an object with \"milestones\", not a list"]));
    let bad = json!({"milestones": [{"id": "m", "title": "M", "tasks": [{"id": "t", "title": "T", "status": "maybe", "colour": "red"}, {"id": "t", "title": 3}]}], "extra": 1});
    let reply = api.post(&format!("/api/projects/{project}/import"), bad).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "5 problems in the roadmap");
    assert_eq!(
        reply.body["data"]["problems"],
        json!([
            "the file: unknown field \"extra\"",
            "t: unknown field \"colour\"",
            "t: \"status\" is \"maybe\", not one of todo, doing, done",
            "t: id is used by more than one issue",
            "t: \"title\" should be text, not number 3",
        ])
    );
    assert_eq!(api.post("/api/projects/nowhere/import", roadmap()).send().await.status, 404);
}

#[tokio::test]
async fn a_project_is_deleted_with_everything_in_it() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let issue = api.issue(&project, json!({"title": "Sieve"})).await;
    api.post(&format!("/api/projects/{project}/issues/{issue}/comments"), json!({"body": "Begun."})).send().await;
    api.post(&format!("/api/projects/{project}/milestones"), json!({"title": "First"})).send().await;
    api.post(&format!("/api/projects/{project}/docs"), json!({"title": "How", "body": "x"})).send().await;
    let reply = api.delete(&format!("/api/projects/{project}")).send().await;
    assert_eq!(reply.status, 204, "{}", reply.body);
    assert_eq!(reply.changed(), vec![project.clone()]);
    assert_eq!(reply.said("orrery-schedules"), vec![project.clone()], "its schedules went with it");
    for table in ["projects WHERE id", "issues WHERE project", "comments WHERE project", "milestones WHERE project", "docs WHERE project"] {
        assert_eq!(api.count(&format!("SELECT count(*) AS n FROM {table} = '{project}'")).await, 0, "{table}");
    }
    assert_eq!(api.get(&format!("/api/projects/{project}")).send().await.status, 404);
    assert_eq!(api.delete(&format!("/api/projects/{project}")).send().await.status, 404);
}

#[tokio::test]
async fn an_agent_deletes_a_project_only_when_nothing_in_it_is_the_owners() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let refused = api.delete(&format!("/api/projects/{project}")).by_agent("claude").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(refused.body["message"], format!("Deleting {project} is the owner's call: project \"{project}\" was made by the owner"));
    let made = api.post("/api/projects", json!({"name": "Scratch"})).by_agent("claude").send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    assert_eq!(api.delete("/api/projects/scratch").by_agent("claude").send().await.status, 204);
}

#[tokio::test]
async fn a_project_another_takes_releases_from_is_not_deleted() {
    let api = TestApi::new().await;
    make(&api, json!({"name": "Source", "release_mode": "own"})).await;
    make(&api, json!({"name": "Drawing", "releases_from": "source"})).await;
    let reply = api.delete("/api/projects/source").send().await;
    assert_eq!(reply.status, 409, "{}", reply.body);
    assert_eq!(reply.body["message"], "drawing takes its releases from source; give it its own first (releases_from: null)");
    assert_eq!(api.delete("/api/projects/drawing").send().await.status, 204);
    assert_eq!(api.delete("/api/projects/source").send().await.status, 204);
}

#[tokio::test]
async fn every_board_is_listed_when_asked_trimmed_but_for_the_whole_ones() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    api.patch(&format!("/api/projects/{project}/issues/{issue}"), json!({"status": "done", "notes": "Sieved."})).send().await;
    make(&api, json!({"name": "Other"})).await;
    let listed = api.get("/api/projects?expand=board").send().await.body;
    assert_eq!(ids(&listed), ["other", "primes"]);
    assert!(listed[1].get("board").is_some() && listed[1].get("counts").is_none(), "{listed}");
    assert_eq!(issue_ids(&listed[1]), std::slice::from_ref(&issue));
    let trimmed = api.get("/api/projects?expand=board&notes=0&closed=0").send().await.body;
    assert!(issue_ids(&trimmed[1]).is_empty(), "{trimmed}");
    let kept = api.get("/api/projects?expand=board&closed=0&whole=primes").send().await.body;
    assert_eq!(issue_ids(&kept[1]), [issue]);
    assert!(api.get("/api/projects").send().await.body[1].get("board").is_none());
}
