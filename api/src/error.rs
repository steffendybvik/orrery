// A failed request, as the Nuxt server's `createError` sends it: `{statusCode, statusMessage, message, data?}`. The
// router in front (web/server/middleware/zz-api.ts) throws it again there, so the page gets the same reply either way.
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub data: Option<Value>,
}

pub type Result<T> = std::result::Result<T, ApiError>;

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError { status, message: message.into(), data: None }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        let message = message.into();
        ApiError { data: Some(json!({"problems": [message.clone()]})), ..Self::new(StatusCode::BAD_REQUEST, message) }
    }

    pub fn problems(problems: Vec<String>) -> Self {
        let message = if problems.len() > 1 { format!("{} problems in the body", problems.len()) } else { problems.concat() };
        ApiError { data: Some(json!({"problems": problems})), ..Self::new(StatusCode::BAD_REQUEST, message) }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    /// The 403 for what only the owner may do, naming the permissions row that says so (`refusedFor`).
    pub fn refused_for(permission: &str, message: impl Into<String>) -> Self {
        ApiError { data: Some(json!({"permission": permission})), ..Self::new(StatusCode::FORBIDDEN, message) }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    /// A login provider that's set up wrong or didn't answer (ORR-928).
    pub fn provider(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, message)
    }

    /// What can't happen, as the store's `known` refuses it: a 500 naming what was missing.
    pub fn internal(missing: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, format!("Expected {}", missing.into()))
    }

    /// A body bigger than the route takes, said before it's read.
    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, message)
    }

    /// What nobody can do here yet, as this orrery is set up: `closed`, or nobody able to log in.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    /// A request for another database than this API's: the router serves it from the Nuxt server instead.
    pub fn misdirected(message: impl Into<String>) -> Self {
        Self::new(StatusCode::MISDIRECTED_REQUEST, message)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        eprintln!("[orrery-api] database: {error}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "The database failed; see the API's log")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({
            "statusCode": self.status.as_u16(),
            "statusMessage": self.status.canonical_reason().unwrap_or(""),
            "message": self.message,
        });
        if let Some(data) = self.data {
            body["data"] = data;
        }
        (self.status, Json(body)).into_response()
    }
}
