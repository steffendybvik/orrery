// Reading an uploaded image: the handlers and the routes they answer (ORR-1048).
use crate::error::Result;
use crate::{uploads, App, Shared};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/uploads/{upload}", get(get_upload))
}

async fn get_upload(State(app): Shared, Path(upload): Path<String>) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    uploads::upload(&mut conn, &upload).await
}
