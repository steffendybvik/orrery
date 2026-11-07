// Logging in and out, the login status, sign-in links and OIDC: the handlers and the routes they answer (ORR-1048).
use crate::error::{ApiError, Result};
use crate::people::People;
use crate::{auth_mode, body_of, came_of, header, local_host, oidc, owner_asking, people, phone, ways_of, who_of, App, Shared};
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/auth/login", post(log_in))
        .route("/api/auth/logout", post(log_out))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/link", post(auth_link))
        .route("/api/phone/link", post(phone_link))
        .route("/api/auth/oidc/start", get(oidc_start))
        .route("/api/auth/oidc/callback", get(oidc_callback))
}

/// The login cookie's name for the address the browser used (`loginCookie`, ORR-956): with a port in `Host` it carries
/// it, so two orrerys on localhost don't share one; without one (a proxy on 443) it's plain `orrery_login`.
fn login_cookie(headers: &HeaderMap) -> String {
    let host = header(headers, "host").unwrap_or_default();
    match host.rsplit_once(':').filter(|(_, port)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())) {
        Some((_, port)) => format!("orrery_login_{port}"),
        None => "orrery_login".into(),
    }
}

/// A cookie the request carries, by name.
fn cookie_of(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all("cookie").iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|pair| {
        let (key, value) = pair.trim().split_once('=')?;
        (key == name && !value.is_empty()).then(|| percent_decode_str(value).decode_utf8_lossy().into_owned())
    })
}

/// The login's cookie, as `logIn` sets it: http-only so the page's scripts never see it, `Secure` when the request came
/// over https (as the proxy in front says, `X-Forwarded-Proto`).
fn login_set_cookie(headers: &HeaderMap, secret: &str) -> String {
    let secure =
        came_of(headers).https || header(headers, "x-forwarded-proto").is_some_and(|p| p.split(',').next().unwrap_or("").trim().eq_ignore_ascii_case("https"));
    format!(
        "{}={secret}; Max-Age={}; Path=/; HttpOnly;{} SameSite=Lax",
        login_cookie(headers),
        people::LOGIN_DAYS * 86_400,
        if secure { " Secure;" } else { "" }
    )
}

/// `POST /api/auth/login` {key} → {person}: swaps a person key for a login's cookie (web/server/api/auth/login.post.ts).
/// Written ahead of the swap: the router keeps logging in for itself until the API is the front door.
async fn log_in(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let mut conn = app.pool.acquire().await?;
    let (person, secret) = People::new(&mut conn).log_in(&body_of(&body)).await?;
    let mut response = Json(json!({"person": person})).into_response();
    let cookie = HeaderValue::from_str(&login_set_cookie(&headers, &secret)).map_err(|_| ApiError::internal("a login cookie"))?;
    response.headers_mut().append(axum::http::header::SET_COOKIE, cookie);
    Ok(response)
}

/// `POST /api/auth/logout` → 204: ends this browser's login, on the server as well as its cookie (logout.post.ts).
async fn log_out(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let name = login_cookie(&headers);
    if let Some(secret) = cookie_of(&headers, &name) {
        let mut conn = app.pool.acquire().await?;
        People::new(&mut conn).log_out(&secret).await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    let cookie = HeaderValue::from_str(&format!("{name}=; Max-Age=0; Path=/")).map_err(|_| ApiError::internal("a login cookie"))?;
    response.headers_mut().append(axum::http::header::SET_COOKIE, cookie);
    Ok(response)
}

/// `GET /api/auth/status` → {mode, person?, via?, can_get_in, oidc, warn_http, phone} (status.get.ts): whether this
/// orrery asks for a login, who this browser is, and `phone` on the phone's own port (ORR-837). Open, as the login page
/// needs it first; it says nothing about anyone else. Written ahead of the swap: the router keeps it the Nuxt server's.
async fn auth_status(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let came = came_of(&headers);
    let ways = ways_of(&headers);
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    let mode = auth_mode(&mut people, came, &ways).await?;
    let can_get_in = ways.provider || people.owner_has_key().await?;
    let host = header(&headers, "orrery-host").or_else(|| header(&headers, "host")).unwrap_or_default();
    let mut status = json!({
        "mode": mode,
        "can_get_in": can_get_in,
        "oidc": ways.provider,
        "warn_http": mode == "on" && !came.https && !local_host(&host),
        "phone": came.phone,
    });
    if let Some(who) = who_of(&headers) {
        status["person"] = json!(who.person);
        status["via"] = json!(if who.browser { "browser" } else { "agent" });
    }
    Ok(Json(status).into_response())
}

/// `POST /api/phone/link` → 201 {token, code, expires_at} (phone/link.post.ts): a one-time sign-in link for App
/// settings' QR code (ORR-837), and its code (ORR-875). Only the owner makes one, from their own page: never over the
/// phone's port, so a phone signed in can't hand out more, and never a session, the chat or an untrusted one, which
/// would get a login as the owner. Written ahead of the swap.
async fn phone_link(State(app): Shared, headers: HeaderMap) -> Result<Response> {
    let came = came_of(&headers);
    if came.phone {
        return Err(ApiError::forbidden("A sign-in link is made from orrery's page on its own machine"));
    }
    let mut conn = app.pool.acquire().await?;
    let mut people = People::new(&mut conn);
    let mode = auth_mode(&mut people, came, &ways_of(&headers)).await?;
    let who = who_of(&headers);
    if mode != "off" && !who.as_ref().is_some_and(|w| w.owner && w.browser) {
        return Err(ApiError::forbidden("Only the owner makes a sign-in link, from their own page"));
    }
    if !owner_asking(&headers) {
        let kind = match header(&headers, "orrery-actor-kind").as_deref() {
            Some("chat") => "the owner's chat",
            Some("untrusted") => "an untrusted session",
            _ => "a session",
        };
        return Err(ApiError::refused_for(
            "phone.link",
            format!("Make a sign-in link for a phone: refused for {kind} (phone.link). The link signs a phone in as the owner (ORR-837), so only the owner’s own page on this machine makes one, never a session, which would get a login it must never have."),
        ));
    }
    let Some(owner) = people.named_owner().await? else {
        return Err(ApiError::conflict("This orrery has no owner yet: give your name first (App settings → You)"));
    };
    let made = app.phone.make(&owner, phone::now_ms());
    Ok((StatusCode::CREATED, Json(json!({"token": made.token, "code": made.code, "expires_at": made.expires_at}))).into_response())
}

/// `POST /api/auth/link` {token} or {code} → 201 {person} (auth/link.post.ts): signs this browser in with a one-time link
/// from the QR code, or the six-letter code under it (ORR-875), using it up. The login is the phone's own, named so, so
/// it's ended on its own from App settings (ORR-838). Open, as the browser has nothing else yet. Written ahead of the swap.
async fn auth_link(State(app): Shared, headers: HeaderMap, body: Bytes) -> Result<Response> {
    let body = body_of(&body);
    let now = phone::now_ms();
    let typed = body.get("code").is_some_and(|c| !c.is_null());
    let person = if typed {
        app.phone.take_code(body.get("code").and_then(Value::as_str), now)
    } else {
        app.phone.take_link(body.get("token").and_then(Value::as_str), now)
    };
    let Some(person) = person else {
        return Err(ApiError::unauthorized(if typed {
            "That code is wrong, used or has run out: check it against App settings on your computer, or press New code there"
        } else {
            "This sign-in link has been used or has run out: show the QR code in App settings again"
        }));
    };
    let mut conn = app.pool.acquire().await?;
    let secret = People::new(&mut conn).start_login(&person, None, Some(phone::PHONE_LOGIN)).await?;
    let mut response = (StatusCode::CREATED, Json(json!({"person": person}))).into_response();
    let cookie = HeaderValue::from_str(&login_set_cookie(&headers, &secret)).map_err(|_| ApiError::internal("a login cookie"))?;
    response.headers_mut().append(axum::http::header::SET_COOKIE, cookie);
    Ok(response)
}

/// A redirect as `sendRedirect` sends it: a 302 to `to`, with a page that goes there for a browser that ignores it.
fn redirect(to: &str) -> Result<Response> {
    let page = format!(r#"<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url={}"></head></html>"#, to.replace('"', "%22"));
    let mut response = (StatusCode::FOUND, [(axum::http::header::CONTENT_TYPE, "text/html")], page).into_response();
    let location = HeaderValue::from_str(to).map_err(|_| ApiError::internal("a redirect"))?;
    response.headers_mut().insert(axum::http::header::LOCATION, location);
    Ok(response)
}

fn with_cookie(mut response: Response, cookie: &str) -> Result<Response> {
    let cookie = HeaderValue::from_str(cookie).map_err(|_| ApiError::internal("a cookie"))?;
    response.headers_mut().append(axum::http::header::SET_COOKIE, cookie);
    Ok(response)
}

/// `GET /api/auth/oidc/start?invite=&back=` → a redirect to the provider's login (web/server/api/auth/oidc/start.get.ts).
/// `back`: the page's origin, when it's hosted on a site NUXT_ALLOWED_ORIGINS lists (ORR-667); any other is ignored.
/// 404 when no provider is set up. Written ahead of the swap: the router keeps it the Nuxt server's.
async fn oidc_start(headers: HeaderMap, RawQuery(raw): RawQuery) -> Result<Response> {
    if !oidc::on() {
        return Err(ApiError::not_found("This orrery has no login provider"));
    }
    let query = oidc::parse_query(raw.as_deref());
    let invite = oidc::query_value(&query, "invite").filter(|i| !i.is_empty());
    let (to, cookie) = oidc::start(&headers, invite, oidc::query_value(&query, "back")).await?;
    with_cookie(redirect(&to)?, &cookie)
}

/// `GET /api/auth/oidc/callback` → a redirect to the board, logged in (to its page on another site when it started
/// there, ORR-667): where the provider sends the browser back (callback.get.ts). An account orrery doesn't know needs
/// an invite, so nobody gets in only by having an account with the provider. The kept cookie is cleared either way.
async fn oidc_callback(State(app): Shared, headers: HeaderMap, RawQuery(raw): RawQuery) -> Result<Response> {
    if !oidc::on() {
        return Err(ApiError::not_found("This orrery has no login provider"));
    }
    let query = oidc::parse_query(raw.as_deref());
    let kept = cookie_of(&headers, oidc::COOKIE);
    let done: Result<Response> = async {
        let found = oidc::finish(&headers, oidc::query_value(&query, "state"), oidc::query_value(&query, "code"), kept).await?;
        let mut conn = app.pool.acquire().await?;
        let mut people = People::new(&mut conn);
        let Some(person) = people.identity(&found.issuer, &found.subject, found.invite.as_deref()).await? else {
            return Err(ApiError::forbidden("This account isn't on this orrery: ask its owner for an invite"));
        };
        let secret = people.start_login(&person, None, None).await?;
        let to = found.back.map_or_else(|| "/".to_owned(), |back| format!("{back}/"));
        with_cookie(redirect(&to)?, &login_set_cookie(&headers, &secret))
    }
    .await;
    let response = match done {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    // Cleared first, as `finishOidc` clears it before anything is checked.
    let mut response = response;
    let cleared = HeaderValue::from_str(&oidc::cleared_cookie()).map_err(|_| ApiError::internal("a cookie"))?;
    let mut cookies: Vec<HeaderValue> = response.headers_mut().get_all(axum::http::header::SET_COOKIE).iter().cloned().collect();
    cookies.insert(0, cleared);
    response.headers_mut().remove(axum::http::header::SET_COOKIE);
    for cookie in cookies {
        response.headers_mut().append(axum::http::header::SET_COOKIE, cookie);
    }
    Ok(response)
}
