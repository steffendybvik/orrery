// An image kept for Markdown to show (ORR-927): what `upload` in web/server/store/signals.ts reads, answering as
// web/server/api/uploads/[upload].get.ts does. Keeping one (`POST /api/uploads`) stays the Nuxt server's, as it
// compresses the image there.
use crate::db::sql;
use crate::error::{ApiError, Result};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use sqlx::{AnyConnection, Row};
use std::sync::LazyLock;

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[0-9a-f]{24}$").unwrap());

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
