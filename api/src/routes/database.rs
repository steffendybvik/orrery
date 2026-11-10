// The database's own file, for the local app's backups (ORR-1097): a consistent copy of it, written where the local
// app says. The local app still checks the copy, puts it in place and lets old ones go (web/server/utils/backup.ts),
// as those are files in its backup folder; only the copy reads the database, so only it is the API's.
use crate::db::on_postgres;
use crate::error::{ApiError, Result};
use crate::request::body_of;
use crate::{App, Shared};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use std::path::Path;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/database/snapshot", post(snapshot))
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

#[cfg(test)]
#[path = "database_tests.rs"]
mod tests;
