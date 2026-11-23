// An image kept for Markdown to show (ORR-927): keeping one as `createUpload` in web/server/store/signals.ts does,
// compressed as compress.ts has it (ORR-1058), and reading it back, answering as web/server/api/uploads/[upload].get.ts
// does.
use crate::access::seen::Seen;
use crate::board::compress::compress_image;
use crate::board::export::UPLOAD;
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
use std::collections::HashSet;
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
pub(crate) fn type_of(bytes: &[u8]) -> Option<&'static str> {
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
pub(crate) fn decode(base64: &str) -> Vec<u8> {
    let mut text: String = base64.chars().filter(|c| !c.is_whitespace() && *c != '=').collect();
    if text.len() % 4 == 1 {
        text.pop();
    }
    LENIENT.decode(text).unwrap_or_default()
}

/// Keeps an image for Markdown to show: `{data, name?}` → where it's served and the Markdown that shows it. A PNG or
/// JPEG is kept as WebP when that's smaller (compress.rs). It's `workspace`'s (ORR-1226): the one the request acts in.
pub async fn create_upload(conn: &mut AnyConnection, body: &Value, actor: &Actor, workspace: &str) -> Result<Value> {
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
    sqlx::query(&sql("INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at, workspace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"))
        .bind(&id)
        .bind(kind)
        .bind(name.as_deref())
        .bind(size)
        .bind(data)
        .bind(&actor.name)
        .bind(i64::from(actor.owner))
        .bind(stamp())
        .bind(workspace)
        .execute(conn)
        .await?;
    let url = format!("/api/uploads/{id}");
    // Brackets would end the alt text early.
    let alt = EXTENSION.replace(name.as_deref().unwrap_or("image"), "").replace(['[', ']', '\\'], "");
    Ok(json!({"id": id, "type": kind, "size": size, "url": url, "markdown": format!("![{alt}]({url})")}))
}

/// The image's bytes, as kept, with the headers the route sends: it never changes, so the browser keeps it, and it's
/// only ever an image, never a page that could run something. One outside the workspaces `seen` reaches isn't there
/// (ORR-1226), as with the rails; an untrusted session also reaches its own project's workspace.
pub async fn upload(conn: &mut AnyConnection, id: &str, seen: &Seen) -> Result<Response> {
    let row = if ID.is_match(id) {
        sqlx::query(&sql("SELECT type, data, workspace FROM uploads WHERE id = ?")).bind(id).fetch_optional(&mut *conn).await?
    } else {
        None
    };
    let row = match row {
        Some(row) if reaches(conn, seen, &row.get::<String, _>("workspace")).await? => row,
        _ => return Err(ApiError::not_found(format!("No image {id}"))),
    };
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

/// Whether `seen` reaches `workspace`: one of its own, or, for an untrusted session, its project's.
async fn reaches(conn: &mut AnyConnection, seen: &Seen, workspace: &str) -> Result<bool> {
    match seen {
        Seen::All => Ok(true),
        Seen::Only { workspaces, .. } if workspaces.iter().any(|w| w == workspace) => Ok(true),
        Seen::Only { own: Some(own), .. } => Ok(own_workspace(conn, own).await?.as_deref() == Some(workspace)),
        Seen::Only { .. } => Ok(false),
    }
}

/// The workspace of an untrusted session's own project, if it's here.
async fn own_workspace(conn: &mut AnyConnection, project: &str) -> Result<Option<String>> {
    let row = sqlx::query(&sql("SELECT workspace FROM projects WHERE id = ?")).bind(project).fetch_optional(conn).await?;
    Ok(row.map(|r| r.get("workspace")))
}

/// The workspace an upload is kept in: the one the request acts in (`Seen::pick`), or, for an untrusted session in none
/// of its own, its project's.
pub(crate) async fn workspace_for(conn: &mut AnyConnection, seen: &Seen, named: Option<&str>) -> Result<String> {
    match (seen.pick(named), seen) {
        (Ok(workspace), _) => Ok(workspace.id().to_string()),
        (Err(error), Seen::Only { own: Some(own), .. }) => match own_workspace(conn, own).await? {
            Some(workspace) if named.is_none_or(|n| n == workspace) => Ok(workspace),
            _ => Err(error),
        },
        (Err(error), _) => Err(error),
    }
}

/// The tables whose text never counts as showing an image (ORR-1250): the images themselves, and the event log and the
/// changes, which only tell of what happened. Every other text column of every table does, as `uploadsReferred` in
/// web/server/store/signals.ts reads them, so a table added later is never missed.
const NOT_SHOWING: [&str; 3] = ["uploads", "events", "changes"];

/// How long an image nothing shows is left be (ORR-1250): one being written into a comment isn't shown yet.
const GRACE_HOURS: i64 = 24;

/// The ids of the images something shows, in any workspace: an image is never taken while anything at all shows it.
pub(crate) async fn shown(conn: &mut AnyConnection) -> Result<HashSet<String>> {
    let columns: Vec<(String, String)> = sqlx::query_as(if crate::db::on_postgres() {
        "SELECT CAST(table_name AS TEXT), CAST(column_name AS TEXT) FROM information_schema.columns \
         WHERE table_schema = current_schema() AND data_type IN ('text', 'character varying', 'json', 'jsonb')"
    } else {
        "SELECT m.name, c.name FROM sqlite_master m JOIN pragma_table_info(m.name) c \
         WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND upper(c.type) NOT IN ('BLOB', 'INTEGER', 'REAL')"
    })
    .fetch_all(&mut *conn)
    .await?;
    let columns: Vec<_> = columns.into_iter().filter(|(table, _)| !NOT_SHOWING.contains(&table.as_str())).collect();
    if !columns.iter().any(|(table, column)| table == "comments" && column == "body") {
        return Err(ApiError::internal("which columns hold text"));
    }
    let mut ids = HashSet::new();
    for (table, column) in columns {
        let text = sql(&format!("SELECT CAST(\"{column}\" AS TEXT) FROM \"{table}\" WHERE CAST(\"{column}\" AS TEXT) LIKE ?"));
        let found: Vec<(Option<String>,)> = sqlx::query_as(&text).bind("%/api/uploads/%").fetch_all(&mut *conn).await?;
        for text in found.into_iter().filter_map(|(text,)| text) {
            ids.extend(UPLOAD.captures_iter(&text).filter_map(|found| found.get(1)).map(|m| m.as_str().to_string()));
        }
    }
    Ok(ids)
}

/// The moment before which an image nothing shows counts as unused.
fn grace() -> String {
    (chrono::Utc::now() - chrono::Duration::hours(GRACE_HOURS)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `workspace`'s images, newest first, each with whether anything shows it (`used`) and whether it's unused: shown
/// nowhere and more than a day old. With `unused_only`, only those. `count` and `size` add up what's listed.
pub async fn list_uploads(conn: &mut AnyConnection, workspace: &str, unused_only: bool) -> Result<Value> {
    let shown = shown(conn).await?;
    let before = grace();
    let found = sqlx::query(&sql("SELECT id, type, name, size, created_by, created_at FROM uploads WHERE workspace = ? ORDER BY created_at DESC, id"))
        .bind(workspace)
        .fetch_all(&mut *conn)
        .await?;
    let mut listed = vec![];
    let mut size = 0_i64;
    for row in found {
        let id: String = row.get("id");
        let created_at: String = row.get("created_at");
        let used = shown.contains(&id);
        let unused = !used && created_at < before;
        if unused_only && !unused {
            continue;
        }
        let bytes: i64 = row.get("size");
        size += bytes;
        listed.push(json!({
            "id": id,
            "type": row.get::<String, _>("type"),
            "name": row.get::<Option<String>, _>("name"),
            "size": bytes,
            "created_by": row.get::<String, _>("created_by"),
            "created_at": created_at,
            "used": used,
            "unused": unused,
            "url": format!("/api/uploads/{id}"),
        }));
    }
    Ok(json!({"count": listed.len(), "size": size, "uploads": listed}))
}

/// Removes one of `workspace`'s images: 404 when it isn't one, 409 while something still shows it.
pub async fn delete_upload(conn: &mut AnyConnection, id: &str, workspace: &str) -> Result<()> {
    let found = if ID.is_match(id) {
        sqlx::query(&sql("SELECT id FROM uploads WHERE id = ? AND workspace = ?")).bind(id).bind(workspace).fetch_optional(&mut *conn).await?
    } else {
        None
    };
    if found.is_none() {
        return Err(ApiError::not_found(format!("No image {id}")));
    }
    if shown(conn).await?.contains(id) {
        return Err(ApiError::conflict(format!("Image {id} is still shown: take it out of what shows it first")));
    }
    sqlx::query(&sql("DELETE FROM uploads WHERE id = ?")).bind(id).execute(conn).await?;
    Ok(())
}

/// Removes every unused image of `workspace` (shown nowhere, more than a day old) in one go → `{count, size}` removed.
pub async fn sweep_uploads(conn: &mut AnyConnection, workspace: &str) -> Result<Value> {
    let listed = list_uploads(conn, workspace, true).await?;
    let ids: Vec<String> = listed["uploads"].as_array().into_iter().flatten().filter_map(|u| u["id"].as_str().map(String::from)).collect();
    for chunk in ids.chunks(200) {
        let marks = vec!["?"; chunk.len()].join(", ");
        let text = sql(&format!("DELETE FROM uploads WHERE id IN ({marks})"));
        let mut q = sqlx::query(&text);
        for id in chunk {
            q = q.bind(id);
        }
        q.execute(&mut *conn).await?;
    }
    Ok(json!({"count": listed["count"], "size": listed["size"]}))
}
