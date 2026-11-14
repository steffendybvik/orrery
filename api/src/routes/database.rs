// What the local app asks of the database itself (ORR-1140): whether it's a new orrery's, and how big a Postgres one
// is. And its SQLite file compacted after a clean-up (ORR-1134).
use crate::db::on_postgres;
use crate::error::Result;
use crate::request::body_of;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use sqlx::Row;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/database", get(state))
        .route("/api/database/compact", post(compact))
}

/// `{fresh, size?}`: `fresh` when it's a new orrery's (no projects, no owner named yet), as the local app asks as it
/// starts, to say where a Docker orrery's data may be; `size`, in bytes, for a Postgres database as it reports itself
/// (left out when it can't say, as on a managed one). A SQLite file's size is the local app's, from the file.
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
