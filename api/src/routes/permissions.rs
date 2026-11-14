// The permissions table (ORR-1086): what each kind of session may do (web/shared/permissions.ts), so a session can see
// it has to ask before it tries and is refused. The Sessions page's Permissions tab shows the same. It's the file the
// rails hold writes to (api/permissions.json), sent as written.
use crate::access::rails::TABLE;
use crate::App;
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/permissions", get(permissions))
}

async fn permissions() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/json")], TABLE)
}

#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;
