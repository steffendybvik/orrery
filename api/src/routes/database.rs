// The database's own file, for the local app's backups (ORR-1097): a consistent copy of it, written where the local
// app says. The local app still checks the copy, puts it in place and lets old ones go (web/server/utils/backup.ts),
// as those are files in its backup folder; only the copy reads the database, so only it is the API's. And what the
// local app's backups and App settings → Database ask of the database itself (ORR-1140): whether it's a new orrery's,
// how big a Postgres one is, and the name the orrery runs under, kept for its backups to carry.
use crate::db::{on_postgres, sql};
use crate::error::{ApiError, Result};
use crate::request::body_of;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use sqlx::Row;
use std::path::Path;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/database", get(state))
        .route("/api/database/snapshot", post(snapshot))
        .route("/api/database/compact", post(compact))
        .route("/api/database/environment", put(environment))
}

/// `{fresh, size?}`: `fresh` when it's a new orrery's (no projects, no owner named yet), as the local app asks before
/// it offers a backup to start from; `size`, in bytes, for a Postgres database as it reports itself (left out when it
/// can't say, as on a managed one). A SQLite file's size is the local app's, from the file.
async fn state(State(app): Shared) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let projects: i64 = sqlx::query("SELECT count(*) AS n FROM projects").fetch_one(&mut *conn).await?.try_get("n")?;
    let owner = sqlx::query("SELECT 1 AS found FROM people WHERE role = 'owner'").fetch_optional(&mut *conn).await?;
    let mut reply = json!({"fresh": projects == 0 && owner.is_none()});
    if on_postgres() {
        let size = sqlx::query("SELECT pg_database_size(current_database()) AS size").fetch_one(&mut *conn).await;
        if let Ok(size) = size.and_then(|row| row.try_get::<i64, _>("size")) {
            reply["size"] = json!(size);
        }
    }
    Ok(Json(reply).into_response())
}

/// `{environment}`: keeps the name the orrery runs under (`personal`, `work`, …) in its settings, so its backups say
/// which orrery they're a copy of. The local app's, as it starts.
async fn environment(State(app): Shared, body: Bytes) -> Result<Response> {
    let said = body_of(&body).get("environment").and_then(Value::as_str).map(str::to_string);
    let said = said.filter(|name| !name.is_empty()).ok_or_else(|| ApiError::bad_request("environment: the name this orrery runs under"))?;
    let statement = "INSERT INTO settings (key, value) VALUES ('environment', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
    sqlx::query(&sql(statement)).bind(Value::String(said).to_string()).execute(&app.pool).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `{to}`: writes a copy of the SQLite database to `to` with `VACUUM INTO`, which reads it as one transaction, so the
/// writes go on meanwhile. `to` is a `.partial` file in a folder that's there, and not there itself, as the local app
/// makes it ready (`partial` in backup.ts) before it puts the copy in place. A Postgres database is the local app's to
/// snapshot still: 409.
async fn snapshot(State(app): Shared, body: Bytes) -> Result<Response> {
    if on_postgres() {
        return Err(ApiError::conflict("A Postgres database is snapshotted by the local app, not the API"));
    }
    let to = body_of(&body).get("to").and_then(|to| to.as_str()).map(str::to_string);
    let to = to.ok_or_else(|| ApiError::bad_request("to: the path to write the copy to"))?;
    let path = Path::new(&to);
    if !path.is_absolute() || !to.ends_with(".partial") {
        return Err(ApiError::bad_request("to: an absolute path to a .partial file"));
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(ApiError::conflict(format!("{to}: its folder isn't there")));
    }
    if path.exists() {
        return Err(ApiError::conflict(format!("{to} is there already: the local app clears it first")));
    }
    sqlx::query("VACUUM INTO ?").bind(&to).execute(&app.pool).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Compacting is worth it from this much free: 32 MB, and a quarter of the file (`COMPACT_FROM` in housekeeping.ts).
const COMPACT_FROM_BYTES: i64 = 32 * 1024 * 1024;
const COMPACT_FROM_SHARE: f64 = 0.25;

/// A SQLite pragma that answers with a number.
async fn pragma(conn: &mut sqlx::AnyConnection, name: &str) -> Result<i64> {
    Ok(sqlx::query(&format!("PRAGMA {name}")).fetch_one(conn).await?.try_get::<i64, _>(0)?)
}

/// `{always?}`: `{compacted}`, whether the SQLite file was compacted (`VACUUM`) and its `-wal` written through and cut
/// back (ORR-1134). Only with that much free, as housekeeping asks after a clean-up; `always`, whatever is free, as the
/// local app asks once it has compressed the images. A Postgres database keeps its own space: never.
async fn compact(State(app): Shared, body: Bytes) -> Result<Response> {
    if on_postgres() {
        return Ok(Json(json!({"compacted": false})).into_response());
    }
    let always = body_of(&body).get("always").and_then(Value::as_bool).unwrap_or(false);
    let mut conn = app.pool.acquire().await?;
    if !always {
        let (free, size, pages) = (pragma(&mut conn, "freelist_count").await?, pragma(&mut conn, "page_size").await?, pragma(&mut conn, "page_count").await?);
        if free * size < COMPACT_FROM_BYTES || (free as f64) < COMPACT_FROM_SHARE * pages as f64 {
            return Ok(Json(json!({"compacted": false})).into_response());
        }
    }
    sqlx::query("VACUUM").execute(&mut *conn).await?;
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&mut *conn).await?;
    Ok(Json(json!({"compacted": true})).into_response())
}

#[cfg(test)]
#[path = "database_tests.rs"]
mod tests;
