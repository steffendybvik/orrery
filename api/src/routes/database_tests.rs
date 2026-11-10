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
