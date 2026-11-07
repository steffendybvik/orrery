// The tests of routes/uploads.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::json;

const ID: &str = "0123456789abcdef01234567";

/// Keeps an image as `POST /api/uploads` would, straight into the table: that route is the Nuxt server's.
async fn keep(api: &TestApi, id: &str, kind: &str, data: &[u8]) {
    sqlx::query(&crate::db::sql("INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"))
        .bind(id)
        .bind(kind)
        .bind("dot.png")
        .bind(data.len() as i64)
        .bind(data.to_vec())
        .bind("owner")
        .bind(1_i64)
        .bind("2026-11-07T00:00:00.000Z")
        .execute(&api.app.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn an_image_is_served_as_kept_and_never_as_a_page() {
    let api = TestApi::new().await;
    keep(&api, ID, "image/png", b"PNGBYTES").await;
    let reply = api.get(&format!("/api/uploads/{ID}")).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, json!("PNGBYTES"));
    assert_eq!(reply.header("content-type"), Some("image/png"));
    assert_eq!(reply.header("cache-control"), Some("private, max-age=31536000, immutable"), "it never changes, so it's kept");
    assert_eq!(reply.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(reply.header("content-security-policy"), Some("default-src 'none'; sandbox"));
    assert_eq!(reply.header("orrery-changed"), None, "reading it changes nothing");
}

#[tokio::test]
async fn an_image_is_read_by_any_actor() {
    let api = TestApi::new().await;
    keep(&api, ID, "image/webp", b"x").await;
    assert_eq!(api.get(&format!("/api/uploads/{ID}")).by_agent("claude").send().await.status, 200);
}

#[tokio::test]
async fn an_image_that_is_not_there_or_not_an_id_is_not_found() {
    let api = TestApi::new().await;
    keep(&api, ID, "image/png", b"x").await;
    for id in ["fedcba9876543210fedcba98", "0123456789ABCDEF01234567", "0123456789abcdef0123456", "0123456789abcdef012345678", "nope"] {
        let reply = api.get(&format!("/api/uploads/{id}")).send().await;
        assert_eq!(reply.status, 404, "{id}: {}", reply.body);
        assert_eq!(reply.body["message"], format!("No image {id}"));
    }
}
