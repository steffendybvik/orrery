// An image kept for Markdown to show (ORR-927): keeping one as `createUpload` in web/server/store/signals.ts does,
// compressed as compress.ts has it (ORR-1058), and reading it back, answering as web/server/api/uploads/[upload].get.ts
// does.
use crate::board::compress::compress_image;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{js, stamp, Actor};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use regex::Regex;
use serde_json::{json, Value};
use sqlx::{AnyConnection, Row};
use std::sync::LazyLock;

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[0-9a-f]{24}$").unwrap());
static DATA_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new("^data:[^,]*;base64,").unwrap());
static BASE64: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9+/\s]*={0,2}\s*$").unwrap());
static EXTENSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.[a-z0-9]+$").unwrap());

/// The biggest image kept (`UPLOAD_LIMIT`).
pub(crate) const UPLOAD_LIMIT: usize = 10 * 1024 * 1024;
/// A body too big to hold the largest image (base64 makes it a third bigger) is refused before it's read.
pub(crate) const BODY_LIMIT: usize = (UPLOAD_LIMIT * 4).div_ceil(3) + 64 * 1024;

/// What an upload's body may hold (`UPLOAD_FIELDS`).
const FIELDS: [&str; 2] = ["data", "name"];

/// Base64 as Node's `Buffer.from(…, 'base64')` reads it: padding or none, and the last bits as they are.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
);

/// An upload's body as `checkInput` takes it against `UPLOAD_FIELDS`: `data` a string that isn't blank, `name` a string
/// or null.
fn check_input(body: &Value) -> Result<(String, Option<String>)> {
    let Some(sent) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
    let mut problems = vec![];
    for key in sent.keys() {
        if !FIELDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", FIELDS.join(", ")));
        }
    }
    let mut data = None;
    let mut name = None;
    match sent.get("data") {
        None => problems.push("missing \"data\"".into()),
        Some(Value::Null) => problems.push("\"data\" can't be null".into()),
        Some(Value::String(text)) if text.trim().is_empty() => problems.push("\"data\" can't be empty".into()),
        Some(Value::String(text)) => data = Some(text.clone()),
        Some(other) => problems.push(format!("\"data\" should be a string, not {}", js(other))),
    }
    match sent.get("name") {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) => name = Some(text.clone()),
        Some(other) => problems.push(format!("\"name\" should be a string, not {}", js(other))),
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok((data.unwrap_or_default(), name))
}

/// The image's type from its first bytes (`IMAGE_TYPES`): PNG, JPEG, GIF or WebP.
fn type_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// The base64 as Node decodes it: whitespace skipped, and a last character too many dropped.
fn decode(base64: &str) -> Vec<u8> {
    let mut text: String = base64.chars().filter(|c| !c.is_whitespace() && *c != '=').collect();
    if text.len() % 4 == 1 {
        text.pop();
    }
    LENIENT.decode(text).unwrap_or_default()
}

/// Keeps an image for Markdown to show: `{data, name?}` → where it's served and the Markdown that shows it. A PNG or
/// JPEG is kept as WebP when that's smaller (compress.rs).
pub async fn create_upload(conn: &mut AnyConnection, body: &Value, actor: &Actor) -> Result<Value> {
    let (data, name) = check_input(body)?;
    let base64 = DATA_URL.replace(&data, "");
    if !BASE64.is_match(&base64) {
        return Err(ApiError::bad_request("\"data\" should be the image in base64"));
    }
    let bytes = decode(&base64);
    if bytes.is_empty() {
        return Err(ApiError::bad_request("\"data\" is empty"));
    }
    if bytes.len() > UPLOAD_LIMIT {
        let megabytes = bytes.len() as f64 / 1024.0 / 1024.0;
        return Err(ApiError::bad_request(format!("The image is {megabytes:.1} MB; {} MB at most", UPLOAD_LIMIT / 1024 / 1024)));
    }
    let Some(came) = type_of(&bytes) else { return Err(ApiError::bad_request("That isn't a PNG, JPEG, GIF or WebP image")) };
    // Decoding and encoding take the CPU for a while: off the threads that answer requests.
    let (kind, data) = tokio::task::spawn_blocking(move || compress_image(bytes, came)).await.map_err(|_| ApiError::internal("the image compressed"))?;
    let name = name.map(|n| n.trim().chars().take(200).collect::<String>()).filter(|n| !n.is_empty());
    let id = crate::work::settings::hex(12);
    let size = data.len() as i64;
    sqlx::query(&sql("INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"))
        .bind(&id)
        .bind(kind)
        .bind(name.as_deref())
        .bind(size)
        .bind(data)
        .bind(&actor.name)
        .bind(i64::from(actor.owner))
        .bind(stamp())
        .execute(conn)
        .await?;
    let url = format!("/api/uploads/{id}");
    // Brackets would end the alt text early.
    let alt = EXTENSION.replace(name.as_deref().unwrap_or("image"), "").replace(['[', ']', '\\'], "");
    Ok(json!({"id": id, "type": kind, "size": size, "url": url, "markdown": format!("![{alt}]({url})")}))
}

/// The image's bytes, as kept, with the headers the route sends: it never changes, so the browser keeps it, and it's
/// only ever an image, never a page that could run something.
pub async fn upload(conn: &mut AnyConnection, id: &str) -> Result<Response> {
    let row = if ID.is_match(id) { sqlx::query(&sql("SELECT type, data FROM uploads WHERE id = ?")).bind(id).fetch_optional(conn).await? } else { None };
    let row = row.ok_or_else(|| ApiError::not_found(format!("No image {id}")))?;
    let kind: String = row.get("type");
    let data: Vec<u8> = row.get("data");
    let mut response = data.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(&kind).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox"));
    Ok(response)
}
