// The tests of routes/database.rs (ORR-1097), through `router()` on a database of their own (`crate::testing`).
use crate::db::on_postgres;
use crate::testing::TestApi;
use serde_json::json;
use sqlx::{Connection, Row};
use std::path::PathBuf;

/// A folder of its own for the copies, with nothing in it.
fn folder() -> PathBuf {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).unwrap();
    let dir = std::env::temp_dir().join(format!("orrery-api-snapshot-{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn a_snapshot_is_a_copy_of_the_board_that_passes_its_check() {
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    let to = folder().join(".orrery.db.partial");
    let reply = api.post("/api/database/snapshot", json!({"to": to.to_string_lossy()})).send().await;
    if on_postgres() {
        assert_eq!(reply.status, 409, "{}", reply.body);
        return;
    }
    assert_eq!(reply.status, 204, "{}", reply.body);
    let mut copy = sqlx::AnyConnection::connect(&format!("sqlite://{}?mode=ro", to.to_string_lossy())).await.unwrap();
    let check: String = sqlx::query("PRAGMA quick_check").fetch_one(&mut copy).await.unwrap().get(0);
    assert_eq!(check, "ok");
    let names: Vec<String> = sqlx::query("SELECT id FROM projects").fetch_all(&mut copy).await.unwrap().iter().map(|row| row.get(0)).collect();
    assert_eq!(names, [project]);
}

#[tokio::test]
async fn it_writes_only_a_partial_file_that_isnt_there_yet_in_a_folder_that_is() {
    let api = TestApi::new().await;
    if on_postgres() {
        return;
    }
    let dir = folder();
    let refused = |to: String| {
        let request = api.post("/api/database/snapshot", json!({"to": to}));
        async move { request.send().await }
    };
    assert_eq!(api.post("/api/database/snapshot", json!({})).send().await.status, 400);
    assert_eq!(refused("relative/.orrery.db.partial".into()).await.status, 400);
    assert_eq!(refused(dir.join("orrery.db").to_string_lossy().into_owned()).await.status, 400);
    assert_eq!(refused(dir.join("missing").join(".orrery.db.partial").to_string_lossy().into_owned()).await.status, 409);
    let there = dir.join(".orrery.db.partial");
    std::fs::write(&there, b"left from before").unwrap();
    assert_eq!(refused(there.to_string_lossy().into_owned()).await.status, 409);
    assert_eq!(std::fs::read(&there).unwrap(), b"left from before");
}

#[tokio::test]
async fn a_new_orrerys_database_is_fresh_until_it_has_a_project_or_an_owner() {
    let api = TestApi::new().await;
    let reply = api.get("/api/database").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["fresh"], true);
    assert_eq!(reply.body.get("size").is_some(), on_postgres(), "only a Postgres database's size is the API's");
    api.owner().await;
    assert_eq!(api.get("/api/database").send().await.body["fresh"], false);

    let api = TestApi::new().await;
    api.board().await;
    assert_eq!(api.get("/api/database").send().await.body["fresh"], false);
}

#[tokio::test]
async fn the_name_it_runs_under_is_kept_in_its_settings() {
    let api = TestApi::new().await;
    for name in ["personal", "work"] {
        assert_eq!(api.put("/api/database/environment", json!({"environment": name})).send().await.status, 204);
        let kept: String = sqlx::query(&crate::db::sql("SELECT value FROM settings WHERE key = 'environment'")).fetch_one(&api.app.pool).await.unwrap().get(0);
        assert_eq!(kept, format!("\"{name}\""));
    }
    assert_eq!(api.put("/api/database/environment", json!({})).send().await.status, 400);
    assert_eq!(api.put("/api/database/environment", json!({"environment": ""})).send().await.status, 400);
}

#[tokio::test]
async fn compacting_waits_for_enough_free_unless_asked_always() {
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    let first = api.post("/api/database/compact", json!({})).send().await;
    assert_eq!(first.status, 200, "{}", first.body);
    // A new board has next to nothing free, so it's let be; and a Postgres database keeps its own space.
    assert_eq!(first.body, json!({"compacted": false}));
    let always = api.post("/api/database/compact", json!({"always": true})).send().await;
    assert_eq!(always.status, 200, "{}", always.body);
    assert_eq!(always.body, json!({"compacted": !on_postgres()}));
    // The board is still there after.
    assert_eq!(api.get(&format!("/api/projects/{project}")).send().await.status, 200);
}

#[tokio::test]
async fn every_row_of_the_tables_asked_comes_back_as_it_is_stored() {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let api = TestApi::new().await;
    let (project, _) = api.board().await;
    let gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;";
    let upload = api.post("/api/uploads", json!({"data": STANDARD.encode(gif)})).send().await;
    assert_eq!(upload.status, 201, "{}", upload.body);
    let reply = api.post("/api/database/rows", json!({"tables": ["projects", "uploads", "settings"]})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let tables = &reply.body["tables"];
    assert_eq!(tables.as_object().unwrap().keys().collect::<Vec<_>>(), ["projects", "uploads", "settings"], "in the order asked");
    let projects = tables["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["id"], project.as_str());
    let uploads = tables["uploads"].as_array().unwrap();
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0]["id"], upload.body["id"]);
    assert_eq!(uploads[0]["size"], json!(gif.len()), "an integer stays a number");
    assert_eq!(uploads[0]["name"], json!(null), "no name stays null");
    assert_eq!(uploads[0]["data"], json!({"$base64": STANDARD.encode(gif)}), "bytes come as base64");
}

#[tokio::test]
async fn only_a_list_of_table_names_is_read() {
    let api = TestApi::new().await;
    assert_eq!(api.post("/api/database/rows", json!({})).send().await.status, 400);
    assert_eq!(api.post("/api/database/rows", json!({"tables": []})).send().await.status, 400);
    assert_eq!(api.post("/api/database/rows", json!({"tables": ["projects; DROP TABLE projects"]})).send().await.status, 400);
    assert_eq!(api.post("/api/database/rows", json!({"tables": ["Projects"]})).send().await.status, 400);
    assert_eq!(api.post("/api/database/rows", json!({"tables": [1]})).send().await.status, 400);
}
