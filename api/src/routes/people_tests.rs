// The tests of routes/people.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{ids, TestApi};
use crate::write::stamp;
use serde_json::{json, Value};
use sqlx::Row;

/// A login, put straight in the table: `id` is its hash, as the router sends it in `Orrery-Login`.
async fn login(api: &TestApi, id: &str, person: &str, by_key: Option<&str>, expires_at: &str) {
    sqlx::query(&crate::db::sql("INSERT INTO logins (id, person, expires_at, by_key, known, created_at, last_used_at) VALUES (?, ?, ?, ?, 1, ?, ?)"))
        .bind(id)
        .bind(person)
        .bind(expires_at)
        .bind(by_key.map(str::to_owned))
        .bind(stamp())
        .bind(stamp())
        .execute(&api.app.pool)
        .await
        .unwrap();
}

fn later() -> String {
    (chrono::Utc::now() + chrono::Duration::days(1)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// A login id as the logins table keeps one: 64 hex digits, its first 16 starting with `c`.
fn hashed(c: char) -> String {
    std::iter::repeat(c).take(64).collect()
}

#[tokio::test]
async fn lists_the_owner_first_then_people_in_the_order_they_were_added_the_removed_with_when() {
    let api = TestApi::new().await;
    api.member("ada", "Ada").await;
    api.owner().await;
    api.member("bo", "Bo").await;
    sqlx::query(&crate::db::sql("UPDATE people SET removed_at = ? WHERE id = 'ada'")).bind(stamp()).execute(&api.app.pool).await.unwrap();
    let listed = api.get("/api/people").send().await;
    assert_eq!(listed.status, 200);
    assert_eq!(ids(&listed.body), ["steffen", "ada", "bo"]);
    assert_eq!(listed.body[0]["role"], "owner");
    assert!(listed.body[1]["removed_at"].is_string(), "{}", listed.body);
    assert!(listed.body[2].get("removed_at").is_none(), "{}", listed.body);
}

#[tokio::test]
async fn adds_a_member_whose_id_is_their_name_in_snake_case() {
    let api = TestApi::new().await;
    api.owner().await;
    let added = api.post("/api/people", json!({"name": "  Ada Lovelace "})).header("orrery-login-ways", "provider").send().await;
    assert_eq!(added.status, 201, "{}", added.body);
    assert_eq!(
        (added.body["id"].as_str(), added.body["name"].as_str(), added.body["role"].as_str()),
        (Some("ada_lovelace"), Some("Ada Lovelace"), Some("member"))
    );
    assert!(added.body["created_at"].is_string());
    assert_eq!(ids(&api.get("/api/people").send().await.body), ["steffen", "ada_lovelace"]);
    // A member of the one workspace there is so far (ORR-1106).
    let role: Option<String> = sqlx::query_scalar(&crate::db::sql("SELECT role FROM workspace_members WHERE workspace = 'default' AND person = ?"))
        .bind("ada_lovelace")
        .fetch_optional(&api.app.pool)
        .await
        .unwrap();
    assert_eq!(role.as_deref(), Some("member"));
}

#[tokio::test]
async fn a_second_person_is_refused_until_someone_could_log_in() {
    let api = TestApi::new().await;
    api.owner().await;
    let refused = api.post("/api/people", json!({"name": "Ada"})).send().await;
    assert_eq!(refused.status, 409, "{}", refused.body);
    assert_eq!(api.count("SELECT count(*) FROM people").await, 1);
    // ORRERY_AUTH=off, a provider, or the owner's person key each make a way in.
    assert_eq!(api.post("/api/people", json!({"name": "Ada"})).header("orrery-login-ways", "off").send().await.status, 201);
    let key = api.post("/api/keys", json!({"kind": "person", "name": "laptop"})).header("orrery-actor-name", "Steffen").send().await;
    assert_eq!(key.status, 201, "{}", key.body);
    assert_eq!(api.post("/api/people", json!({"name": "Bo"})).send().await.status, 201);
}

#[tokio::test]
async fn an_agent_key_or_a_revoked_person_key_is_no_way_in() {
    let api = TestApi::new().await;
    api.owner().await;
    let agent = api.post("/api/keys", json!({"kind": "agent", "name": "box"})).header("orrery-actor-name", "Steffen").send().await;
    assert_eq!(agent.status, 201);
    assert_eq!(api.post("/api/people", json!({"name": "Ada"})).send().await.status, 409);
    let person = api.post("/api/keys", json!({"kind": "person", "name": "laptop"})).header("orrery-actor-name", "Steffen").send().await;
    let id = person.body["id"].as_str().unwrap();
    assert_eq!(api.delete(&format!("/api/keys/{id}")).header("orrery-actor-name", "Steffen").send().await.status, 204);
    assert_eq!(api.post("/api/people", json!({"name": "Ada"})).send().await.status, 409);
}

#[tokio::test]
async fn the_owner_names_themselves_before_adding_anyone() {
    let api = TestApi::new().await;
    let refused = api.post("/api/people", json!({"name": "Ada"})).header("orrery-login-ways", "off").send().await;
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert_eq!(api.count("SELECT count(*) FROM people").await, 0);
}

#[tokio::test]
async fn the_names_agents_and_orrery_go_by_are_refused() {
    let api = TestApi::new().await;
    api.owner().await;
    for name in ["owner", "Agent", " Claude ", "ORRERY"] {
        let refused = api.post("/api/people", json!({"name": name})).header("orrery-login-ways", "off").send().await;
        assert_eq!(refused.status, 400, "{name}: {}", refused.body);
    }
    assert_eq!(api.count("SELECT count(*) FROM people").await, 1);
}

#[tokio::test]
async fn an_id_taken_by_someone_here_or_someone_removed_stays_theirs() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    api.member("bo", "Bo").await;
    sqlx::query(&crate::db::sql("UPDATE people SET removed_at = ? WHERE id = 'bo'")).bind(stamp()).execute(&api.app.pool).await.unwrap();
    for name in ["ADA", "Bo", "Steffen"] {
        let refused = api.post("/api/people", json!({"name": name})).header("orrery-login-ways", "off").send().await;
        assert_eq!(refused.status, 409, "{name}: {}", refused.body);
    }
    let row = sqlx::query("SELECT name, removed_at FROM people WHERE id = 'bo'").fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(row.get::<String, _>("name"), "Bo");
    assert!(row.get::<Option<String>, _>("removed_at").is_some());
}

#[tokio::test]
async fn a_person_needs_a_name_and_nothing_else() {
    let api = TestApi::new().await;
    api.owner().await;
    for body in [
        json!({}),
        json!({"name": null}),
        json!({"name": "   "}),
        json!({"name": 7}),
        json!({"name": "Ada", "role": "owner"}),
        json!("Ada"),
        json!({"name": "!!!"}),
    ] {
        let refused = api.post("/api/people", body.clone()).header("orrery-login-ways", "off").send().await;
        assert_eq!(refused.status, 400, "{body}: {}", refused.body);
    }
    let unknown = api.post("/api/people", json!({"name": "Ada", "role": "owner"})).header("orrery-login-ways", "off").send().await;
    assert_eq!(unknown.body["data"]["problems"][0], "unknown field \"role\"; this takes name");
    assert_eq!(api.count("SELECT count(*) FROM people").await, 1);
}

#[tokio::test]
async fn a_name_is_kept_to_sixty_characters() {
    let api = TestApi::new().await;
    api.owner().await;
    let added = api.post("/api/people", json!({"name": "a".repeat(80)})).header("orrery-login-ways", "off").send().await;
    assert_eq!(added.status, 201);
    assert_eq!(added.body["name"].as_str().unwrap().chars().count(), 60);
}

#[tokio::test]
async fn a_session_cant_add_rename_remove_or_invite_anyone() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let ways = "provider, off";
    let tries = [
        api.post("/api/people", json!({"name": "Bo"})),
        api.patch("/api/people/ada", json!({"name": "Ada L"})),
        api.delete("/api/people/ada"),
        api.post("/api/invites", json!({"person": "ada"})),
    ];
    for req in tries {
        let refused = req.by_agent("claude").header("orrery-actor-named", "ada").header("orrery-login-ways", ways).send().await;
        assert_eq!(refused.status, 403, "{}", refused.body);
        assert_eq!(refused.body["data"]["permission"], "people.write");
    }
    assert_eq!(api.count("SELECT count(*) FROM people WHERE removed_at IS NULL").await, 2);
    assert_eq!(api.count("SELECT count(*) FROM invites").await, 0);
    let ada: String = sqlx::query("SELECT name FROM people WHERE id = 'ada'").fetch_one(&api.app.pool).await.unwrap().get("name");
    assert_eq!(ada, "Ada");
}

#[tokio::test]
async fn with_login_on_only_the_owner_in_their_own_browser_manages_people() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    // The owner's agent key, or a member's browser, even with an actor that claims to be the owner.
    let as_owners_agent = api.delete("/api/people/ada").agent_key("steffen", true).send().await;
    assert_eq!(as_owners_agent.status, 403, "{}", as_owners_agent.body);
    let as_member = api.delete("/api/people/ada").browser("ada", false).send().await;
    assert_eq!(as_member.status, 403, "{}", as_member.body);
    let adds = api.post("/api/people", json!({"name": "Bo"})).browser("ada", false).header("orrery-login-ways", "provider").send().await;
    assert_eq!(adds.status, 403);
    assert_eq!(api.count("SELECT count(*) FROM people WHERE removed_at IS NULL").await, 2);
    let as_owner = api.delete("/api/people/ada").browser("steffen", true).send().await;
    assert_eq!(as_owner.status, 204, "{}", as_owner.body);
}

#[tokio::test]
async fn renames_a_member_keeping_their_id() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let renamed = api.patch("/api/people/ada", json!({"name": "Countess Lovelace"})).send().await;
    assert_eq!(renamed.status, 200, "{}", renamed.body);
    assert_eq!((renamed.body["id"].as_str(), renamed.body["name"].as_str()), (Some("ada"), Some("Countess Lovelace")));
    assert_eq!(api.get("/api/people").send().await.body[1]["name"], "Countess Lovelace");
}

#[tokio::test]
async fn renaming_refuses_the_owner_someone_removed_someone_unknown_and_a_bad_name() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    api.member("bo", "Bo").await;
    sqlx::query(&crate::db::sql("UPDATE people SET removed_at = ? WHERE id = 'bo'")).bind(stamp()).execute(&api.app.pool).await.unwrap();
    assert_eq!(api.patch("/api/people/steffen", json!({"name": "S"})).send().await.status, 400);
    assert_eq!(api.patch("/api/people/bo", json!({"name": "Bob"})).send().await.status, 409);
    assert_eq!(api.patch("/api/people/nobody", json!({"name": "N"})).send().await.status, 404);
    assert_eq!(api.patch("/api/people/ada", json!({"name": ""})).send().await.status, 400);
    let names: Vec<String> =
        sqlx::query("SELECT name FROM people ORDER BY created_at, id").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("name")).collect();
    assert_eq!(names, ["Steffen", "Ada", "Bo"]);
}

#[tokio::test]
async fn removing_a_person_revokes_their_keys_and_ends_their_logins_and_invites() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let key = api.post("/api/keys", json!({"person": "ada", "kind": "agent", "name": "box"})).header("orrery-actor-name", "Steffen").send().await;
    assert_eq!(key.status, 201, "{}", key.body);
    login(&api, &hashed('a'), "ada", None, &later()).await;
    login(&api, &hashed('b'), "steffen", None, &later()).await;
    let invite = api.post("/api/invites", json!({"person": "ada"})).header("orrery-login-ways", "provider").send().await;
    assert_eq!(invite.status, 201, "{}", invite.body);
    let removed = api.delete("/api/people/ada").send().await;
    assert_eq!(removed.status, 204, "{}", removed.body);
    assert_eq!(api.count("SELECT count(*) FROM keys WHERE person = 'ada' AND revoked_at IS NULL").await, 0);
    assert_eq!(api.count("SELECT count(*) FROM logins WHERE person = 'ada'").await, 0);
    assert_eq!(api.count("SELECT count(*) FROM logins WHERE person = 'steffen'").await, 1, "the owner's login stays");
    assert_eq!(api.count("SELECT count(*) FROM invites").await, 0);
    let listed = api.get("/api/people").send().await;
    assert!(listed.body[1]["removed_at"].is_string(), "{}", listed.body);
}

#[tokio::test]
async fn removing_a_person_hands_their_boards_to_the_owner() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let shared = api.project("Shared").await;
    let held = api.project("Held").await;
    sqlx::query("DELETE FROM project_members").execute(&api.app.pool).await.unwrap();
    for (project, person, role) in [(&shared, "ada", "member"), (&shared, "steffen", "owner"), (&held, "ada", "owner")] {
        sqlx::query(&crate::db::sql("INSERT INTO project_members (project, person, role, created_at) VALUES (?, ?, ?, ?)"))
            .bind(project)
            .bind(person)
            .bind(role)
            .bind(stamp())
            .execute(&api.app.pool)
            .await
            .unwrap();
    }
    assert_eq!(api.delete("/api/people/ada").send().await.status, 204);
    let rows: Vec<(String, String, String)> = sqlx::query("SELECT project, person, role FROM project_members ORDER BY project")
        .fetch_all(&api.app.pool)
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get("project"), r.get("person"), r.get("role")))
        .collect();
    let mut expected = vec![(held.clone(), "steffen".to_string(), "owner".to_string()), (shared.clone(), "steffen".to_string(), "owner".to_string())];
    expected.sort();
    assert_eq!(rows, expected);
}

#[tokio::test]
async fn removing_a_person_unassigns_their_open_issues_and_tells_it() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let project = api.project("Primes").await;
    let open = api.issue(&project, json!({"title": "Open", "assignee": "ada"})).await;
    let done = api.issue(&project, json!({"title": "Done", "assignee": "ada"})).await;
    sqlx::query(&crate::db::sql("UPDATE issues SET status = (SELECT id FROM statuses WHERE kind = 'done' LIMIT 1) WHERE id = ?"))
        .bind(&done)
        .execute(&api.app.pool)
        .await
        .unwrap();
    let before = api.count("SELECT CAST(COALESCE(MAX(id), 0) AS BIGINT) FROM changes").await;
    let removed = api.delete("/api/people/ada").send().await;
    assert_eq!(removed.status, 204, "{}", removed.body);
    let assignee = |id: String| {
        let pool = api.app.pool.clone();
        async move {
            sqlx::query(&crate::db::sql("SELECT assignee FROM issues WHERE id = ?"))
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<Option<String>, _>("assignee")
        }
    };
    assert_eq!(assignee(open.clone()).await, None);
    assert_eq!(assignee(done.clone()).await.as_deref(), Some("ada"), "a done issue keeps who did it");
    let noted =
        sqlx::query(&crate::db::sql("SELECT \"before\", \"after\", created_by FROM issue_events WHERE issue = ? AND field = 'assignee' AND \"after\" IS NULL"))
            .bind(&open)
            .fetch_all(&api.app.pool)
            .await
            .unwrap();
    assert_eq!(noted.len(), 1);
    assert_eq!(noted[0].get::<String, _>("before"), "ada");
    assert_eq!(removed.header("orrery-changed"), Some(project.as_str()));
    let told = removed.header("orrery-told").expect("the unassigning is told");
    assert_eq!(told, format!("issue%2Eassignee {project} {} ada ~", open.replace('-', "%2D")));
    // And the outbox has the same, after what was there.
    let feed = api.get(&format!("/api/changes?after={before}")).send().await;
    let kinds: Vec<&str> = feed.body["changes"].as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"project.changed") && kinds.contains(&"issue.assignee"), "{}", feed.body);
    let told = feed.body["changes"].as_array().unwrap().iter().find(|c| c["kind"] == "issue.assignee").unwrap();
    assert_eq!((told["subject"].as_str(), told["payload"]["from"].as_str(), told["actor"].as_str()), (Some(open.as_str()), Some("ada"), Some("owner")));
}

#[tokio::test]
async fn removing_someone_already_removed_changes_nothing() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    assert_eq!(api.delete("/api/people/ada").send().await.status, 204);
    let first: String = sqlx::query("SELECT removed_at FROM people WHERE id = 'ada'").fetch_one(&api.app.pool).await.unwrap().get("removed_at");
    let again = api.delete("/api/people/ada").send().await;
    assert_eq!(again.status, 204);
    assert!(again.header("orrery-told").is_none());
    let second: String = sqlx::query("SELECT removed_at FROM people WHERE id = 'ada'").fetch_one(&api.app.pool).await.unwrap().get("removed_at");
    assert_eq!(first, second);
}

#[tokio::test]
async fn the_owner_cant_be_removed_and_an_unknown_person_isnt_found() {
    let api = TestApi::new().await;
    api.owner().await;
    assert_eq!(api.delete("/api/people/steffen").send().await.status, 400);
    assert_eq!(api.delete("/api/people/nobody").send().await.status, 404);
    assert_eq!(api.count("SELECT count(*) FROM people WHERE removed_at IS NULL").await, 1);
}

#[tokio::test]
async fn invites_a_person_with_a_link_good_for_a_week_whose_secret_isnt_kept() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let invite = api
        .post("/api/invites", json!({"person": "ada"}))
        .header("orrery-login-ways", "provider")
        .header("orrery-origin", "https://orrery.example")
        .send()
        .await;
    assert_eq!(invite.status, 201, "{}", invite.body);
    let url = invite.body["url"].as_str().unwrap();
    let secret = url.strip_prefix("https://orrery.example/login?invite=").expect("the link is at the origin asked");
    assert!(secret.len() >= 40, "{url}");
    let expires = chrono::DateTime::parse_from_rfc3339(invite.body["expires_at"].as_str().unwrap()).unwrap();
    let days = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_hours();
    assert!((167..=168).contains(&days), "{days} hours");
    let row = sqlx::query("SELECT id, person, used_at FROM invites").fetch_one(&api.app.pool).await.unwrap();
    assert_ne!(row.get::<String, _>("id"), secret, "only the secret's hash is kept");
    assert_eq!(row.get::<String, _>("id").len(), 64);
    assert_eq!(row.get::<String, _>("person"), "ada");
    assert_eq!(row.get::<Option<String>, _>("used_at"), None);
}

#[tokio::test]
async fn an_invite_needs_a_provider_and_someone_here_to_invite() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    api.member("bo", "Bo").await;
    sqlx::query(&crate::db::sql("UPDATE people SET removed_at = ? WHERE id = 'bo'")).bind(stamp()).execute(&api.app.pool).await.unwrap();
    assert_eq!(api.post("/api/invites", json!({"person": "ada"})).header("orrery-login-ways", "off").send().await.status, 409);
    let provider = |body: Value| api.post("/api/invites", body).header("orrery-login-ways", "provider");
    assert_eq!(provider(json!({})).send().await.status, 400);
    assert_eq!(provider(json!({"person": 3})).send().await.status, 400);
    assert_eq!(provider(json!({"person": "nobody"})).send().await.status, 404);
    assert_eq!(provider(json!({"person": "bo"})).send().await.status, 404);
    assert_eq!(api.count("SELECT count(*) FROM invites").await, 0);
}

#[tokio::test]
async fn makes_a_key_shown_this_once_with_its_kind_in_its_prefix() {
    let api = TestApi::new().await;
    api.owner().await;
    let made = api.post("/api/keys", json!({"kind": "agent", "name": "  the build box  "})).header("orrery-actor-name", "Steffen").send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    let key = made.body["key"].as_str().unwrap();
    assert!(key.starts_with("orrery_agent_") && key.len() > 50, "{key}");
    assert_eq!((made.body["person"].as_str(), made.body["kind"].as_str(), made.body["name"].as_str()), (Some("steffen"), Some("agent"), Some("the build box")));
    let person = api.post("/api/keys", json!({"kind": "person", "name": "laptop"})).header("orrery-actor-name", "Steffen").send().await;
    assert!(person.body["key"].as_str().unwrap().starts_with("orrery_person_"));
    // Listed, the newest first, never with the key or its hash.
    let listed = api.get("/api/keys").header("orrery-actor-name", "Steffen").send().await;
    assert_eq!(listed.status, 200);
    assert_eq!(ids(&listed.body), [person.body["id"].as_str().unwrap(), made.body["id"].as_str().unwrap()]);
    let text = listed.body.to_string();
    assert!(!text.contains(key) && !text.contains("\"key\"") && !text.contains("hash"), "{text}");
    let hash: String =
        sqlx::query(&crate::db::sql("SELECT hash FROM keys WHERE id = ?")).bind(made.body["id"].as_str()).fetch_one(&api.app.pool).await.unwrap().get("hash");
    assert_ne!(hash, key);
}

#[tokio::test]
async fn a_key_needs_a_kind_and_a_name_and_someone_here() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("bo", "Bo").await;
    sqlx::query(&crate::db::sql("UPDATE people SET removed_at = ? WHERE id = 'bo'")).bind(stamp()).execute(&api.app.pool).await.unwrap();
    let make = |body: Value| api.post("/api/keys", body).header("orrery-actor-name", "Steffen");
    assert_eq!(make(json!({"name": "box"})).send().await.status, 400);
    assert_eq!(make(json!({"kind": "owner", "name": "box"})).send().await.status, 400);
    assert_eq!(make(json!({"kind": "agent"})).send().await.status, 400);
    assert_eq!(make(json!({"kind": "agent", "name": "   "})).send().await.status, 400);
    assert_eq!(make(json!({"kind": "agent", "name": "box", "person": "nobody"})).send().await.status, 404);
    assert_eq!(make(json!({"kind": "agent", "name": "box", "person": "bo"})).send().await.status, 404, "never a key for someone removed");
    let long = make(json!({"kind": "agent", "name": "x".repeat(70)})).send().await;
    assert_eq!(long.body["name"].as_str().unwrap().len(), 60);
    assert_eq!(api.count("SELECT count(*) FROM keys").await, 1);
}

#[tokio::test]
async fn a_person_makes_their_own_keys_but_never_one_for_someone_else() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    api.member("bo", "Bo").await;
    let own = api.post("/api/keys", json!({"kind": "agent", "name": "box"})).member_browser("ada").send().await;
    assert_eq!(own.status, 201, "{}", own.body);
    assert_eq!(own.body["person"], "ada");
    for whose in ["bo", "steffen"] {
        let refused = api.post("/api/keys", json!({"kind": "person", "name": "x", "person": whose})).member_browser("ada").send().await;
        assert_eq!(refused.status, 403, "{whose}: {}", refused.body);
        assert_eq!(refused.body["data"]["permission"], "keys.write");
    }
    assert_eq!(api.count("SELECT count(*) FROM keys WHERE person <> 'ada'").await, 0);
    // The owner hands one to anyone.
    let given = api.post("/api/keys", json!({"kind": "person", "name": "x", "person": "bo"})).browser("steffen", true).send().await;
    assert_eq!(given.status, 201, "{}", given.body);
    assert_eq!(given.body["person"], "bo");
}

#[tokio::test]
async fn a_session_never_lists_makes_or_revokes_a_key_whatever_key_it_has() {
    let api = TestApi::new().await;
    api.owner().await;
    let made = api.post("/api/keys", json!({"kind": "agent", "name": "box"})).header("orrery-actor-name", "Steffen").send().await;
    let id = made.body["id"].as_str().unwrap().to_string();
    let path = format!("/api/keys/{id}");
    // A session with login off, and the owner's own agent key with login on, which claims the owner.
    let as_session = [
        api.get("/api/keys").by_agent("claude"),
        api.post("/api/keys", json!({"kind": "person", "name": "x"})).by_agent("claude"),
        api.delete(&path).by_agent("claude"),
    ];
    let as_agent_key = [
        api.get("/api/keys").agent_key("steffen", true),
        api.post("/api/keys", json!({"kind": "person", "name": "x"})).agent_key("steffen", true),
        api.delete(&path).agent_key("steffen", true),
    ];
    for req in as_session.into_iter().chain(as_agent_key) {
        let refused = req.send().await;
        assert_eq!(refused.status, 403, "{}", refused.body);
        assert_eq!(refused.body["data"]["permission"], "keys.write");
    }
    assert_eq!(api.count("SELECT count(*) FROM keys WHERE revoked_at IS NULL").await, 1);
}

#[tokio::test]
async fn a_person_lists_their_own_keys_and_the_owner_everyones() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    for person in ["ada", "steffen"] {
        let made = api.post("/api/keys", json!({"kind": "agent", "name": "box", "person": person})).header("orrery-actor-name", "Steffen").send().await;
        assert_eq!(made.status, 201);
    }
    let ada = api.get("/api/keys").member_browser("ada").send().await;
    assert_eq!(ada.status, 200);
    assert_eq!(ada.body.as_array().unwrap().len(), 1);
    assert_eq!(ada.body[0]["person"], "ada");
    let everyone = api.get("/api/keys").browser("steffen", true).send().await;
    assert_eq!(everyone.body.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn revoking_a_key_ends_the_logins_it_started_and_stays_listed() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let made = api.post("/api/keys", json!({"kind": "person", "name": "laptop"})).member_browser("ada").send().await;
    let other = api.post("/api/keys", json!({"kind": "person", "name": "desk"})).member_browser("ada").send().await;
    let id = made.body["id"].as_str().unwrap();
    login(&api, &hashed('a'), "ada", Some(id), &later()).await;
    login(&api, &hashed('b'), "ada", other.body["id"].as_str(), &later()).await;
    let revoked = api.delete(&format!("/api/keys/{id}")).member_browser("ada").send().await;
    assert_eq!(revoked.status, 204, "{}", revoked.body);
    let ids: Vec<String> = sqlx::query("SELECT id FROM logins").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("id")).collect();
    assert_eq!(ids, [hashed('b')], "only the login the revoked key started ends");
    let listed = api.get("/api/keys").member_browser("ada").send().await;
    let revoked_at = listed.body.as_array().unwrap().iter().find(|k| k["id"] == id).unwrap()["revoked_at"].clone();
    assert!(revoked_at.is_string(), "{}", listed.body);
    // Again changes nothing.
    assert_eq!(api.delete(&format!("/api/keys/{id}")).member_browser("ada").send().await.status, 204);
    let again: String =
        sqlx::query(&crate::db::sql("SELECT revoked_at FROM keys WHERE id = ?")).bind(id).fetch_one(&api.app.pool).await.unwrap().get("revoked_at");
    assert_eq!(json!(again), revoked_at);
}

#[tokio::test]
async fn revoking_a_key_ends_its_persons_logins_from_before_orrery_kept_which_key_started_one() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let made = api.post("/api/keys", json!({"kind": "person", "name": "laptop"})).member_browser("ada").send().await;
    sqlx::query(&crate::db::sql("INSERT INTO logins (id, person, expires_at) VALUES (?, 'ada', ?)"))
        .bind(hashed('c'))
        .bind(later())
        .execute(&api.app.pool)
        .await
        .unwrap();
    login(&api, &hashed('d'), "steffen", None, &later()).await;
    sqlx::query(&crate::db::sql("UPDATE logins SET known = 0 WHERE id = ?")).bind(hashed('d')).execute(&api.app.pool).await.unwrap();
    assert_eq!(api.delete(&format!("/api/keys/{}", made.body["id"].as_str().unwrap())).member_browser("ada").send().await.status, 204);
    let ids: Vec<String> = sqlx::query("SELECT id FROM logins").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("id")).collect();
    assert_eq!(ids, [hashed('d')], "another person's old login stays");
}

#[tokio::test]
async fn a_person_cant_revoke_someone_elses_key_which_isnt_found_for_them() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    api.member("bo", "Bo").await;
    let bos = api.post("/api/keys", json!({"kind": "agent", "name": "box", "person": "bo"})).header("orrery-actor-name", "Steffen").send().await;
    let id = bos.body["id"].as_str().unwrap();
    let refused = api.delete(&format!("/api/keys/{id}")).member_browser("ada").send().await;
    assert_eq!(refused.status, 404, "{}", refused.body);
    assert_eq!(api.count("SELECT count(*) FROM keys WHERE revoked_at IS NULL").await, 1);
    assert_eq!(api.delete("/api/keys/nope").member_browser("ada").send().await.status, 404);
    // The owner revokes anyone's.
    assert_eq!(api.delete(&format!("/api/keys/{id}")).browser("steffen", true).send().await.status, 204);
    assert_eq!(api.count("SELECT count(*) FROM keys WHERE revoked_at IS NULL").await, 0);
}

#[tokio::test]
async fn lists_a_persons_live_logins_marking_the_one_asking_and_never_a_whole_hash() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    login(&api, &hashed('a'), "ada", None, &later()).await;
    login(&api, &hashed('b'), "ada", None, "2000-01-01T00:00:00.000Z").await;
    login(&api, &hashed('c'), "steffen", None, &later()).await;
    let listed = api.get("/api/logins").member_browser("ada").header("orrery-login", &hashed('a')).send().await;
    assert_eq!(listed.status, 200, "{}", listed.body);
    let logins = listed.body.as_array().unwrap();
    assert_eq!(logins.len(), 1, "only ada's, and not the one run out: {}", listed.body);
    assert_eq!(logins[0]["id"].as_str().unwrap(), &hashed('a')[..16]);
    assert_eq!(logins[0]["current"], true);
    assert!(!listed.body.to_string().contains(&hashed('a')));
    let everyone = api.get("/api/logins").browser("steffen", true).header("orrery-login", &hashed('c')).send().await;
    let logins = everyone.body.as_array().unwrap();
    assert_eq!(logins.len(), 2);
    assert_eq!(logins.iter().filter(|l| l["current"] == true).count(), 1);
    assert!(logins.iter().find(|l| l["person"] == "ada").unwrap().get("current").is_none());
}

#[tokio::test]
async fn a_session_has_no_business_with_logins() {
    let api = TestApi::new().await;
    api.owner().await;
    login(&api, &hashed('a'), "steffen", None, &later()).await;
    let path = format!("/api/logins/{}", &hashed('a')[..16]);
    let tries = [
        api.get("/api/logins").by_agent("claude"),
        api.delete("/api/logins").by_agent("claude"),
        api.delete(&path).by_agent("claude"),
        api.get("/api/logins").agent_key("steffen", true),
        api.delete("/api/logins").agent_key("steffen", true),
        api.delete(&path).agent_key("steffen", true),
    ];
    for req in tries {
        let refused = req.send().await;
        assert_eq!(refused.status, 403, "{}", refused.body);
        assert_eq!(refused.body["data"]["permission"], "logins.write");
    }
    assert_eq!(api.count("SELECT count(*) FROM logins").await, 1);
}

#[tokio::test]
async fn ends_a_login_by_its_listed_id() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    login(&api, &hashed('a'), "ada", None, &later()).await;
    login(&api, &hashed('b'), "ada", None, &later()).await;
    let ended = api.delete(&format!("/api/logins/{}", &hashed('a')[..16])).member_browser("ada").send().await;
    assert_eq!(ended.status, 204, "{}", ended.body);
    let ids: Vec<String> = sqlx::query("SELECT id FROM logins").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("id")).collect();
    assert_eq!(ids, [hashed('b')]);
}

#[tokio::test]
async fn a_person_cant_end_someone_elses_login_but_the_owner_can() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    api.member("bo", "Bo").await;
    login(&api, &hashed('b'), "bo", None, &later()).await;
    login(&api, &hashed('e'), "steffen", None, &later()).await;
    for id in [hashed('b'), hashed('e')] {
        let refused = api.delete(&format!("/api/logins/{}", &id[..16])).member_browser("ada").send().await;
        assert_eq!(refused.status, 404, "{}", refused.body);
    }
    assert_eq!(api.count("SELECT count(*) FROM logins").await, 2);
    assert_eq!(api.delete(&format!("/api/logins/{}", &hashed('b')[..16])).browser("steffen", true).send().await.status, 204);
    assert_eq!(api.count("SELECT count(*) FROM logins WHERE person = 'bo'").await, 0);
}

#[tokio::test]
async fn a_login_is_ended_only_by_its_sixteen_digit_reference() {
    let api = TestApi::new().await;
    api.owner().await;
    login(&api, &hashed('a'), "steffen", None, &later()).await;
    // The whole hash, a shorter prefix, or a pattern: none of them names it.
    for reference in [hashed('a'), "aaaa".into(), "%".into(), "AAAAAAAAAAAAAAAA".into(), "aaaaaaaaaaaaaaa_".into()] {
        let refused = api.delete(&format!("/api/logins/{reference}")).header("orrery-actor-name", "Steffen").send().await;
        assert_eq!(refused.status, 404, "{reference}: {}", refused.body);
    }
    assert_eq!(api.count("SELECT count(*) FROM logins").await, 1);
}

#[tokio::test]
async fn ends_every_other_login_of_the_person_asking_but_their_own() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    login(&api, &hashed('a'), "ada", None, &later()).await;
    login(&api, &hashed('b'), "ada", None, &later()).await;
    login(&api, &hashed('c'), "steffen", None, &later()).await;
    let ended = api.delete("/api/logins").member_browser("ada").header("orrery-login", &hashed('a')).send().await;
    assert_eq!(ended.status, 200, "{}", ended.body);
    assert_eq!(ended.body, json!({"ended": 1}));
    let mut ids: Vec<String> = sqlx::query("SELECT id FROM logins").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("id")).collect();
    ids.sort();
    assert_eq!(ids, [hashed('a'), hashed('c')]);
}

#[tokio::test]
async fn the_owner_ends_everyones_logins_but_their_own_and_with_login_off_every_one() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    login(&api, &hashed('a'), "ada", None, &later()).await;
    login(&api, &hashed('c'), "steffen", None, &later()).await;
    let ended = api.delete("/api/logins").browser("steffen", true).header("orrery-login", &hashed('c')).send().await;
    assert_eq!(ended.body, json!({"ended": 1}));
    assert_eq!(api.count("SELECT count(*) FROM logins").await, 1);
    login(&api, &hashed('a'), "ada", None, &later()).await;
    let off = api.delete("/api/logins").header("orrery-actor-name", "Steffen").send().await;
    assert_eq!(off.body, json!({"ended": 2}));
    assert_eq!(api.count("SELECT count(*) FROM logins").await, 0);
}

#[tokio::test]
async fn a_boards_holder_or_the_owner_says_whos_on_it_and_its_holder_stays() {
    let api = TestApi::new().await;
    api.team().await;
    let project = api.project("Primes").await;
    api.run(
        "INSERT INTO project_members (project, person, role, created_at) VALUES (?, 'steffen', 'owner', ?) ON CONFLICT (project, person) DO NOTHING",
        &[&project, &stamp()],
    )
    .await;
    // The owner holds it.
    let members = api.get(&format!("/api/projects/{project}/members")).send().await;
    assert_eq!(members.status, 200);
    assert_eq!(
        members.body.as_array().unwrap().iter().map(|m| (m["person"].clone(), m["role"].clone())).collect::<Vec<_>>(),
        vec![(json!("steffen"), json!("owner"))]
    );
    let added = api.post(&format!("/api/projects/{project}/members"), json!({"person": "Ana"})).send().await;
    assert_eq!(added.status, 201, "{}", added.body);
    assert_eq!((added.body["person"].clone(), added.body["role"].clone(), added.body["name"].clone()), (json!("ana"), json!("member"), json!("ana")));
    assert_eq!(added.changed(), vec![project.clone()]);
    // Again, they stay as they are.
    assert_eq!(api.post(&format!("/api/projects/{project}/members"), json!({"person": "ana"})).send().await.status, 201);
    assert_eq!(api.count(&format!("SELECT count(*) FROM project_members WHERE project = '{project}'")).await, 2);
    // A member isn't its holder, so can't say who's on it.
    let by_ana = api.post(&format!("/api/projects/{project}/members"), json!({"person": "bo"})).person("ana").send().await;
    assert_eq!(by_ana.status, 403, "{}", by_ana.body);
    // Its holder stays on it; anyone else comes off.
    let holder = api.delete(&format!("/api/projects/{project}/members/steffen")).send().await;
    assert_eq!(holder.status, 400);
    assert_eq!(holder.body["message"], format!("steffen holds {project}, so they stay on it"));
    assert_eq!(api.delete(&format!("/api/projects/{project}/members/ana")).send().await.status, 204);
    assert_eq!(api.count(&format!("SELECT count(*) FROM project_members WHERE project = '{project}'")).await, 1);
}

#[tokio::test]
async fn a_board_takes_only_someone_here_and_named_as_a_string() {
    let api = TestApi::new().await;
    api.team().await;
    let project = api.project("Primes").await;
    let add = |body: Value| api.post(&format!("/api/projects/{project}/members"), body).send();
    assert_eq!(add(json!({"person": "nobody"})).await.status, 404);
    let wrong = add(json!({"person": 4, "role": "owner"})).await;
    assert_eq!(wrong.status, 400);
    assert_eq!(wrong.problems().len(), 2, "{}", wrong.body);
    api.run("UPDATE people SET removed_at = ? WHERE id = 'bo'", &["2026-11-01T00:00:00.000Z"]).await;
    assert_eq!(add(json!({"person": "bo"})).await.status, 409);
    assert_eq!(api.get("/api/projects/nowhere/members").send().await.status, 404);
    assert_eq!(api.delete("/api/projects/nowhere/members/ana").send().await.status, 404);
}

#[tokio::test]
async fn the_owner_is_unnamed_until_they_give_their_name_which_anyone_may_the_first_time() {
    let api = TestApi::new().await;
    let unnamed = api.get("/api/owner").send().await;
    assert_eq!(unnamed.body, json!({"name": "owner", "display": "owner", "named": false}));
    let named = api.put("/api/owner", json!({"name": " Sköll Fenrisson "})).by_agent("someone").send().await;
    assert_eq!(named.status, 200, "{}", named.body);
    assert_eq!(named.body, json!({"name": "skoll_fenrisson", "display": "Sköll Fenrisson", "named": true}));
    assert_eq!(api.get("/api/owner").send().await.body, named.body);
    assert_eq!(api.count("SELECT count(*) AS n FROM workspace_members WHERE workspace = 'default' AND person = 'skoll_fenrisson' AND role = 'owner'").await, 1);
    // Then only the owner renames them.
    let refused = api.put("/api/owner", json!({"name": "Mallory"})).by_agent("someone").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
}

#[tokio::test]
async fn naming_the_owner_moves_what_was_theirs_to_the_new_id_and_refuses_reserved_and_taken_names() {
    let api = TestApi::new().await;
    api.owner().await;
    api.member("ada", "Ada").await;
    let project = api.project("Primes").await;
    let issue = api.issue(&project, json!({"title": "Sieve", "assignee": "steffen"})).await;
    for (name, status) in [("Claude", 400), ("agent", 400), ("Ada", 409), ("!!", 400)] {
        let reply = api.put("/api/owner", json!({"name": name})).header("orrery-actor-name", "steffen").send().await;
        assert_eq!(reply.status, status, "{name}: {}", reply.body);
    }
    let renamed = api.put("/api/owner", json!({"name": "Stef"})).header("orrery-actor-name", "steffen").send().await;
    assert_eq!(renamed.status, 200, "{}", renamed.body);
    assert_eq!(renamed.body["name"], "stef");
    assert_eq!(api.count(&format!("SELECT count(*) AS n FROM issues WHERE id = '{issue}' AND assignee = 'stef'")).await, 1);
    assert_eq!(api.count("SELECT count(*) AS n FROM project_members WHERE person = 'stef' AND role = 'owner'").await, 1);
    assert_eq!(api.count("SELECT count(*) AS n FROM people WHERE id = 'steffen'").await, 0);
    assert!(api.outbox().await.iter().any(|c| c.line().contains("settings")), "the page hears the settings changed");
}
