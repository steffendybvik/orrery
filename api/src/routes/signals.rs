// A project's signals, read: the handler and the route it answers (ORR-1087). Their delivery, the stream and the
// listeners stay the Nuxt server's.
use super::P;
use crate::error::Result;
use crate::work::signals::{Signals, Which, LIMIT};
use crate::{App, Shared};
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new().route(&format!("{P}/signals"), get(list_signals))
}

/// `?after=` the signals after that id, oldest first (anything not a number is 0, as `Number(…) || 0` reads it);
/// `?issue=` or `?milestone=` the latest about that issue or milestone instead.
async fn list_signals(State(app): Shared, Path(project): Path<String>, Query(query): Query<HashMap<String, String>>) -> Result<Response> {
    let text = |key: &str| query.get(key).map(String::as_str).filter(|v| !v.is_empty());
    let which = match (text("issue"), text("milestone")) {
        (Some(issue), _) => Which::Issue(issue),
        (None, Some(milestone)) => Which::Milestone(milestone),
        (None, None) => Which::After(after_of(query.get("after").map(String::as_str))),
    };
    let mut conn = app.pool.acquire().await?;
    Ok(Json(Signals::new(&mut conn).list(&project, which, LIMIT).await?).into_response())
}

/// `Number(after ?? 0) || 0`, for what a query string can hold: blank is 0, and so is anything not a number.
pub(crate) fn after_of(sent: Option<&str>) -> f64 {
    let trimmed = sent.unwrap_or("").trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed.parse::<f64>() {
        Ok(n) if n.is_finite() => n,
        // Rust reads `inf` and `nan` too, where JavaScript reads only `Infinity`.
        Ok(n) if trimmed.trim_start_matches(['+', '-']) == "Infinity" => n,
        _ => 0.0,
    }
}

#[cfg(test)]
#[path = "signals_tests.rs"]
mod tests;
