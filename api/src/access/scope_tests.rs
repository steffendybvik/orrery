// The one guard around a workspace's rows (ORR-1355): every way across says why, a workspace's own tables are queried
// only by their stores, and what slipped past a per-route filter before is held.
use super::*;
use crate::testing::TestApi;
use serde_json::json;
use std::path::Path;

#[test]
fn every_way_across_says_why() {
    for across in Across::ALL {
        assert!(!across.why().is_empty(), "{across:?} says why it crosses workspaces");
    }
}

/// A workspace's own tables (ORR-1107) and the files that may name them in SQL, each with why. A new file that queries
/// one has to go through its store, which only takes a `Workspace` the guard made, or be listed here with its reason.
const OWNED: [(&str, &[(&str, &str)]); 8] = [
    (
        "epics",
        &[
            ("board/epics.rs", "the store"),
            ("board/issue_edits.rs", "an issue's epic, held to its project's workspace"),
            ("board/threads.rs", "an epic's thread, which `Epics::epic_id` found in the asker's workspace"),
            ("access/account.rs", "deleting a workspace"),
        ],
    ),
    ("presets", &[("work/presets.rs", "the store"), ("board/projects.rs", "deleting a project's own")]),
    ("preset_defaults", &[("work/presets.rs", "the store")]),
    ("secrets", &[("access/secrets.rs", "the store"), ("work/secrets.rs", "the store's writes"), ("db.rs", "the schema check")]),
    ("secret_uses", &[("access/secrets.rs", "the store"), ("work/secrets.rs", "the store's writes"), ("db.rs", "the schema check")]),
    (
        "workspace_settings",
        &[
            ("work/settings.rs", "the store"),
            ("board/projects.rs", "a project's `starts`, read for its own workspace"),
            ("access/account.rs", "deleting a workspace"),
        ],
    ),
    ("schedules_across", &[("work/schedules.rs", "the store")]),
    ("events", &[("work/event_log.rs", "the store")]),
];

/// The SQL verbs that name a table.
fn names_table(text: &str, table: &str) -> bool {
    ["FROM", "INTO", "UPDATE", "JOIN"].iter().any(|verb| {
        text.match_indices(&format!("{verb} {table}")).any(|(at, found)| {
            let after = text[at + found.len()..].chars().next();
            !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
        })
    })
}

fn sources(dir: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let name = path.strip_prefix(concat!(env!("CARGO_MANIFEST_DIR"), "/src/")).unwrap().to_string_lossy().into_owned();
            if !name.ends_with("_tests.rs") && name != "testing.rs" {
                out.push((name, std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
}

#[test]
fn a_workspaces_own_tables_are_queried_only_by_their_stores() {
    let mut files = Vec::new();
    sources(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")), &mut files);
    let mut strays = Vec::new();
    for (table, allowed) in OWNED {
        for (file, text) in &files {
            if names_table(text, table) && !allowed.iter().any(|(f, _)| f == file) {
                strays.push(format!("{file} queries {table}"));
            }
        }
        for (file, _) in allowed {
            assert!(files.iter().any(|(f, text)| f == file && names_table(text, table)), "{file} no longer queries {table}: take it off OWNED");
        }
    }
    assert!(
        strays.is_empty(),
        "A workspace's own rows go through their store, made with a `Workspace` (access/scope.rs), or are listed in OWNED with why: {strays:#?}"
    );
}

#[test]
fn a_table_is_named_whole() {
    assert!(names_table("SELECT 1 FROM epics WHERE", "epics"));
    assert!(names_table("JOIN events e", "events"));
    assert!(!names_table("SELECT 1 FROM issue_events", "events"));
    assert!(!names_table("SELECT 1 FROM events_seen", "events"));
}

/// Acme's epic Launch, made by bo, who's in Acme: its id.
async fn acmes_epic(api: &TestApi) -> i64 {
    let made = api
        .signed(api.post("/api/epics", json!({"title": "Launch"})).header("orrery-workspace", "acme").header("orrery-sent-origin", "http://localhost"), "bo")
        .await
        .send()
        .await;
    assert_eq!(made.status, 201, "{}", made.body);
    made.body["id"].as_i64().unwrap()
}

#[tokio::test]
async fn an_issue_cant_join_another_workspaces_epic() {
    let api = TestApi::new().await;
    api.team().await;
    api.acme(&["bo"]).await;
    let theirs = acmes_epic(&api).await;
    let (primes, sieve) = api.board().await;
    let ours = api.post("/api/epics", json!({"title": "Tidy"})).send().await;
    assert_eq!(ours.status, 201, "{}", ours.body);
    let ours = ours.body["id"].as_i64().unwrap();

    let made = api.post(&format!("/api/projects/{primes}/issues"), json!({"title": "Rocket", "epic": theirs.to_string()})).send().await;
    assert_eq!(made.status, 404, "Acme's epic isn't there for a project in default: {}", made.body);
    let moved = api.patch(&format!("/api/projects/{primes}/issues/{sieve}"), json!({"epic": theirs.to_string()})).send().await;
    assert_eq!(moved.status, 404, "{}", moved.body);
    let none = api.patch(&format!("/api/projects/{primes}/issues/{sieve}"), json!({"epic": "999999"})).send().await;
    assert_eq!(
        (moved.status, &moved.body["message"].as_str().unwrap().replace(&theirs.to_string(), "N")),
        (none.status, &none.body["message"].as_str().unwrap().replace("999999", "N")),
        "no different from one that isn't there"
    );

    let kept = api.patch(&format!("/api/projects/{primes}/issues/{sieve}"), json!({"epic": ours.to_string()})).send().await;
    assert_eq!(kept.status, 200, "its own workspace's epic: {}", kept.body);
}

#[tokio::test]
async fn a_project_takes_releases_only_from_its_own_workspace() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = api.acme(&["bo"]).await;
    assert_eq!(api.patch(&format!("/api/projects/{rockets}"), json!({"release_mode": "own"})).send().await.status, 200);
    let primes = api.project("Primes").await;
    let theirs = api.patch(&format!("/api/projects/{primes}"), json!({"releases_from": rockets})).send().await;
    let none = api.patch(&format!("/api/projects/{primes}"), json!({"releases_from": "nothing-here"})).send().await;
    assert_eq!(theirs.status, 400, "{}", theirs.body);
    assert_eq!(
        theirs.body["message"].as_str().unwrap().replace(&rockets, "X"),
        none.body["message"].as_str().unwrap().replace("nothing-here", "X"),
        "Acme's project reads as one that isn't there"
    );
    let peers = api.get(&format!("/api/projects/{rockets}/release-peers")).send().await;
    assert_eq!(peers.body, json!([]), "{}", peers.body);
}

#[tokio::test]
async fn a_project_read_through_another_workspaces_store_is_not_there() {
    let api = TestApi::new().await;
    api.team().await;
    let rockets = api.acme(&["bo"]).await;
    let mut conn = api.app.pool.acquire().await.unwrap();
    let default = Workspace::installation();
    let read = crate::board::projects::Projects::of(&mut conn, default).project(&rockets).await;
    assert_eq!(read.err().map(|e| e.status), Some(axum::http::StatusCode::NOT_FOUND));
}
