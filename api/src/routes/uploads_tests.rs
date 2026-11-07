// The tests of routes/uploads.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::board::uploads::{BODY_LIMIT, UPLOAD_LIMIT};
use crate::testing::TestApi;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::codecs::png::PngEncoder;
use image::{ImageEncoder, RgbImage};
use serde_json::json;

const ID: &str = "0123456789abcdef01234567";

/// Keeps an image straight into the table, for reading it back without the upload's compression.
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

/// A PNG of noise, past the size compression leaves alone, and that WebP makes smaller.
fn noisy_png() -> Vec<u8> {
    let mut seed = 0x9e37_79b9_u32;
    let image = RgbImage::from_fn(300, 200, |_, _| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        image::Rgb([(seed >> 24) as u8, (seed >> 16) as u8, (seed >> 8) as u8])
    });
    let mut out = vec![];
    PngEncoder::new(&mut out).write_image(&image, 300, 200, image::ExtendedColorType::Rgb8).unwrap();
    out
}

#[tokio::test]
async fn an_upload_is_kept_compressed_and_served_back() {
    let api = TestApi::new().await;
    let png = noisy_png();
    let reply = api.post("/api/uploads", json!({"data": STANDARD.encode(&png), "name": "  shot [one].png "})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let id = reply.body["id"].as_str().unwrap().to_string();
    assert!(regex::Regex::new("^[0-9a-f]{24}$").unwrap().is_match(&id), "{id}");
    assert_eq!(reply.body["type"], "image/webp", "a PNG WebP makes smaller is kept as WebP");
    let size = reply.body["size"].as_u64().unwrap() as usize;
    assert!(size < png.len());
    assert_eq!(reply.body["url"], format!("/api/uploads/{id}"));
    assert_eq!(reply.body["markdown"], format!("![shot one](/api/uploads/{id})"), "no extension, and no brackets to end the alt text");
    assert_eq!(reply.header("orrery-changed"), None, "an image is on no board until a comment shows it");
    let row: (String, Option<String>, i64, String, i64) =
        sqlx::query_as("SELECT type, name, size, created_by, owned FROM uploads WHERE id = ?").bind(&id).fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(row, ("image/webp".into(), Some("shot [one].png".into()), size as i64, "owner".into(), 1));
    let served = api.get(&format!("/api/uploads/{id}")).send().await;
    assert_eq!((served.status.as_u16(), served.header("content-type")), (200, Some("image/webp")));
}

#[tokio::test]
async fn an_upload_takes_a_data_url_and_keeps_who_sent_it() {
    let api = TestApi::new().await;
    let gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;";
    let data = format!("data:image/gif;base64,{}", STANDARD.encode(gif));
    let reply = api.post("/api/uploads", json!({"data": data, "name": null})).by_agent("claude").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!((reply.body["type"].as_str(), reply.body["size"].as_u64()), (Some("image/gif"), Some(gif.len() as u64)), "a GIF is kept as it came");
    assert!(reply.body["markdown"].as_str().unwrap().starts_with("![image](/api/uploads/"), "no name, so \"image\"");
    let id = reply.body["id"].as_str().unwrap();
    let row: (Option<String>, String, i64) =
        sqlx::query_as("SELECT name, created_by, owned FROM uploads WHERE id = ?").bind(id).fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(row, (None, "claude".into(), 0));
}

#[tokio::test]
async fn base64_is_read_as_node_reads_it() {
    let api = TestApi::new().await;
    // Unpadded, and broken over lines.
    let encoded = STANDARD.encode(b"GIF87a-and-the-rest!").trim_end_matches('=').to_string();
    let wrapped = format!("{}\n{}", &encoded[..10], &encoded[10..]);
    let reply = api.post("/api/uploads", json!({"data": wrapped})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["size"], 20);
}

#[tokio::test]
async fn a_body_that_isnt_an_image_is_refused_in_nuxts_words() {
    let api = TestApi::new().await;
    for (body, message) in [
        (json!([]), "The body should be a JSON object"),
        (json!({}), "missing \"data\""),
        (json!({"data": null}), "\"data\" can't be null"),
        (json!({"data": "  "}), "\"data\" can't be empty"),
        (json!({"data": 5}), "\"data\" should be a string, not 5"),
        (json!({"data": "R0lG", "name": 5}), "\"name\" should be a string, not 5"),
        (json!({"data": "R0lG", "size": 1}), "unknown field \"size\"; this takes data, name"),
        (json!({"data": "not base64!"}), "\"data\" should be the image in base64"),
        (json!({"data": "=="}), "\"data\" is empty"),
        (json!({"data": STANDARD.encode(b"plain text, no image")}), "That isn't a PNG, JPEG, GIF or WebP image"),
    ] {
        let reply = api.post("/api/uploads", body.clone()).send().await;
        assert_eq!(reply.status, 400, "{body}: {}", reply.body);
        assert_eq!(reply.body["message"], message, "{body}");
    }
    let two = api.post("/api/uploads", json!({"name": 5})).send().await;
    assert_eq!((two.status.as_u16(), two.body["message"].as_str()), (400, Some("2 problems in the body")));
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM uploads").fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(count.0, 0, "nothing kept");
}

#[tokio::test]
async fn an_image_over_the_limit_is_refused() {
    let api = TestApi::new().await;
    let mut big = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    big.resize(UPLOAD_LIMIT + 1, 0);
    let reply = api.post("/api/uploads", json!({"data": STANDARD.encode(&big)})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "The image is 10.0 MB; 10 MB at most");
}

#[tokio::test]
async fn a_body_too_big_to_hold_an_image_is_refused_before_its_read() {
    let api = TestApi::new().await;
    // Said by its length, whatever came.
    let said = api.post("/api/uploads", json!({"data": "R0lG"})).header("content-length", &(BODY_LIMIT + 1).to_string()).send().await;
    assert_eq!(said.status, 413);
    assert_eq!(said.body["message"], "An image is 10 MB at most");
    // And one with no length that runs past it.
    let sent = api.post("/api/uploads", json!({"data": "A".repeat(BODY_LIMIT)})).send().await;
    assert_eq!(sent.status, 413, "{}", sent.body);
    assert_eq!(sent.body["statusMessage"], "Payload Too Large");
}
