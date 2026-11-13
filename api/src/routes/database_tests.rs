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

/// What a SQLite copy holds, read straight from its file.
async fn read_copy(path: &std::path::Path, query: &str) -> Vec<String> {
    let mut copy = sqlx::AnyConnection::connect(&format!("sqlite://{}?mode=ro", path.to_string_lossy())).await.unwrap();
    sqlx::query(query).fetch_all(&mut copy).await.unwrap().iter().map(|row| row.get::<String, _>(0)).collect()
}

#[tokio::test]
async fn a_copy_takes_the_whole_board_into_a_new_database_ids_and_all() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let to = folder().join("moved.db");
    let reply = api.post("/api/database/copy", json!({"to": to.to_string_lossy()})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["copied"]["projects"], 1);
    assert_eq!(reply.body["copied"]["issues"], 1);
    assert_eq!(read_copy(&to, "SELECT id FROM projects").await, std::slice::from_ref(&project));
    assert_eq!(read_copy(&to, "SELECT id FROM issues").await, [issue]);
    // The source's own statuses and settings, not the ones a new database starts with.
    let uid = |rows: Vec<String>| rows.into_iter().next();
    let source: String = sqlx::query(&crate::db::sql("SELECT value FROM settings WHERE key = 'uid'")).fetch_one(&api.app.pool).await.unwrap().get(0);
    assert_eq!(uid(read_copy(&to, "SELECT value FROM settings WHERE key = 'uid'").await), Some(source));
    let statuses = api.count("SELECT count(*) FROM statuses").await as usize;
    assert_eq!(read_copy(&to, "SELECT id FROM statuses").await.len(), statuses);
    // The board it came from is as it was.
    assert_eq!(api.get(&format!("/api/projects/{project}")).send().await.status, 200);
}

#[tokio::test]
async fn a_copy_goes_only_into_an_empty_orrery_unless_it_replaces_it_and_marks_a_backup() {
    let api = TestApi::new().await;
    api.board().await;
    let to = folder().join("orrery.db");
    let to = to.to_string_lossy().into_owned();
    assert_eq!(api.post("/api/database/copy", json!({"to": to})).send().await.status, 200);
    let again = api.post("/api/database/copy", json!({"to": to})).send().await;
    assert_eq!(again.status, 409, "{}", again.body);
    let replaced = api.post("/api/database/copy", json!({"to": to, "replace": true, "mark": "orrery-1"})).send().await;
    assert_eq!(replaced.status, 200, "{}", replaced.body);
    let path = std::path::Path::new(&to);
    assert_eq!(read_copy(path, "SELECT id FROM projects").await.len(), 1);
    assert_eq!(read_copy(path, "SELECT value FROM settings WHERE key = 'backup_of'").await, ["\"orrery-1\""]);
}

#[tokio::test]
async fn a_copy_needs_a_database_to_go_to() {
    let api = TestApi::new().await;
    assert_eq!(api.post("/api/database/copy", json!({})).send().await.status, 400);
    assert_eq!(api.post("/api/database/copy", json!({"to": ""})).send().await.status, 400);
    assert_eq!(api.post("/api/database/copy", json!({"to": "relative/orrery.db"})).send().await.status, 400);
}

#[tokio::test]
async fn a_copy_goes_into_postgres_too_cast_to_its_columns() {
    // With a Postgres to test on: a schema of its own there, named in the address as an orrery's would be.
    let Ok(url) = std::env::var("TEST_POSTGRES_URL") else { return };
    if url.is_empty() {
        return;
    }
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let schema = format!("copy_test_{}", crate::testing::random_id());
    let mut admin = sqlx::AnyConnection::connect(&url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA \"{schema}\"")).execute(&mut admin).await.unwrap();
    let to = format!("{url}{}options=-c%20search_path%3D{schema}", if url.contains('?') { '&' } else { '?' });
    let reply = api.post("/api/database/copy", json!({"to": to, "mark": "orrery-1"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let read = |query: String| {
        let url = url.clone();
        async move {
            let mut conn = sqlx::AnyConnection::connect(&url).await.unwrap();
            sqlx::query(&query).fetch_all(&mut conn).await.unwrap().iter().map(|row| row.get::<String, _>(0)).collect::<Vec<_>>()
        }
    };
    assert_eq!(read(format!("SELECT id FROM \"{schema}\".projects")).await, [project]);
    assert_eq!(read(format!("SELECT id FROM \"{schema}\".issues")).await, [issue]);
    assert_eq!(read(format!("SELECT value FROM \"{schema}\".settings WHERE key = 'backup_of'")).await, ["\"orrery-1\""]);
    // Its counters move on past the copied ids: the next comment there isn't refused for one it already has.
    let next = read(format!("SELECT CAST(nextval(pg_get_serial_sequence('\"{schema}\".comments', 'id')) AS text)")).await;
    assert!(next[0].parse::<i64>().unwrap() > api.count("SELECT coalesce(max(id), 0) FROM comments").await);
}
