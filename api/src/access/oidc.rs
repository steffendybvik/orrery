// Logging in through any standard OIDC provider (ORR-928, as web/server/utils/oidc.ts does it, ORR-664): the
// authorization code flow with PKCE, found through the provider's discovery document. The provider says who someone
// is; what they may do stays in orrery's database. Its settings are the Nuxt server's, from the environment
// (NUXT_OIDC_ISSUER, NUXT_OIDC_CLIENT_ID, NUXT_OIDC_CLIENT_SECRET), and so is the list of other sites' pages
// (NUXT_ALLOWED_ORIGINS). Written ahead of the swap: the router keeps these routes the Nuxt server's.
use crate::error::{ApiError, Result};
use axum::http::HeaderMap;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use url::Url;

pub const COOKIE: &str = "orrery_oidc";
pub const COOKIE_PATH: &str = "/api/auth/oidc";
/// How long a started login waits for the way back, in seconds.
const KEPT_FOR: u32 = 600;
/// How long the provider's discovery document is kept.
const FOUND_FOR: Duration = Duration::from_secs(3600);
/// Base64url read as `Buffer.from(…, 'base64url')` does, with its padding or without.
const LENIENT: GeneralPurpose =
    GeneralPurpose::new(&base64::alphabet::URL_SAFE, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));

struct Settings {
    issuer: String,
    client_id: String,
    client_secret: String,
}

fn settings() -> Option<Settings> {
    let read = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    Some(Settings { issuer: read("NUXT_OIDC_ISSUER")?, client_id: read("NUXT_OIDC_CLIENT_ID")?, client_secret: read("NUXT_OIDC_CLIENT_SECRET")? })
}

/// Whether a provider is set up (`oidcOn`): all three settings.
pub fn on() -> bool {
    settings().is_some()
}

fn needs_settings() -> Result<Settings> {
    settings().ok_or_else(|| ApiError::not_found("This orrery has no login provider"))
}

#[derive(Clone, Deserialize)]
struct Provider {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    issuer: String,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
}

/// How the client's secret goes to the token endpoint (ORR-1181, `clientAuth` in oidc.ts): HTTP Basic, which every
/// provider must take (RFC 6749 §2.3.1) and which discovery means when it names none, with the id and secret
/// form-encoded first; in the body only for a provider that names `client_secret_post` and not Basic. The header to
/// send, if any, and whether the secret goes in the body.
pub(crate) fn client_auth(methods: Option<&[String]>, client_id: &str, client_secret: &str) -> (Option<String>, bool) {
    let names = |method: &str| methods.is_some_and(|m| m.iter().any(|x| x == method));
    if names("client_secret_post") && !names("client_secret_basic") {
        return (None, true);
    }
    let encode = |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    let pair = format!("{}:{}", encode(client_id), encode(client_secret));
    (Some(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair))), false)
}

fn trimmed(url: &str) -> &str {
    url.trim_end_matches('/')
}

/// OIDC stays https-only outside this machine, as the provider's word is what logging in rests on.
fn secure(url: &str) -> Result<Url> {
    let parsed = Url::parse(url).map_err(|_| ApiError::provider("The OIDC provider has to be on https"))?;
    let local = matches!(parsed.host_str(), Some("localhost" | "[::1]")) || parsed.host_str().is_some_and(is_loopback_v4);
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
        return Err(ApiError::provider("The OIDC provider has to be on https"));
    }
    Ok(parsed)
}

fn is_loopback_v4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts[0] == "127" && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

fn client() -> Result<reqwest::Client> {
    // No redirects: an endpoint the discovery named is the one asked, and nothing it points on to.
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| ApiError::provider("The OIDC provider can't be reached"))
}

async fn fetch_json<T: for<'de> Deserialize<'de>>(request: reqwest::RequestBuilder) -> Result<T> {
    let response = request.header("Accept", "application/json").send().await.map_err(|_| ApiError::provider("The OIDC provider can't be reached"))?;
    if !response.status().is_success() {
        return Err(ApiError::provider(format!("The OIDC provider answered {}", response.status().as_u16())));
    }
    response.json::<T>().await.map_err(|_| ApiError::provider("The OIDC provider's answer isn't what was expected"))
}

/// Each issuer's discovery document and when it was read.
static FOUND: Mutex<Option<HashMap<String, (Provider, Instant)>>> = Mutex::new(None);

/// The provider's endpoints, from its discovery document, kept for an hour.
async fn provider(settings: &Settings) -> Result<Provider> {
    let issuer = trimmed(&settings.issuer).to_owned();
    if let Some((found, when)) = FOUND.lock().unwrap().get_or_insert_with(HashMap::new).get(&issuer) {
        if when.elapsed() < FOUND_FOR {
            return Ok(found.clone());
        }
    }
    secure(&issuer)?;
    let document: Provider = fetch_json(client()?.get(format!("{issuer}/.well-known/openid-configuration"))).await?;
    if trimmed(&document.issuer) != issuer {
        return Err(ApiError::provider("The OIDC provider gives a different issuer from the one set"));
    }
    for url in [&document.authorization_endpoint, &document.token_endpoint, &document.jwks_uri] {
        secure(url)?;
    }
    FOUND.lock().unwrap().get_or_insert_with(HashMap::new).insert(issuer, (document.clone(), Instant::now()));
    Ok(document)
}

fn first(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(name)?.to_str().ok()?;
    Some(raw.split(',').next().unwrap_or("").trim().to_owned()).filter(|v| !v.is_empty())
}

/// Whether the request came over https, as the proxy in front says (`overHttps`).
pub fn over_https(headers: &HeaderMap) -> bool {
    first(headers, "x-forwarded-proto").as_deref() == Some("https")
}

/// Where the provider sends the browser back: this orrery's own address, as the proxy in front gives it.
fn redirect_uri(headers: &HeaderMap) -> String {
    let host = first(headers, "x-forwarded-host").or_else(|| first(headers, "host")).unwrap_or_else(|| "localhost".into());
    format!("{}://{host}{COOKIE_PATH}/callback", if over_https(headers) { "https" } else { "http" })
}

fn random() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("the system's randomness");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// An origin as a browser sends it (`asOrigin`), or nothing when `value` isn't a plain http(s) one.
pub(crate) fn as_origin(value: &str) -> Option<String> {
    let url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if !url.path().trim_end_matches('/').is_empty() || url.query().is_some_and(|q| !q.is_empty()) || url.fragment().is_some_and(|f| !f.is_empty()) {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// The other sites' pages NUXT_ALLOWED_ORIGINS lists, as it's set.
pub(crate) fn allowed_origins() -> String {
    std::env::var("NUXT_ALLOWED_ORIGINS").unwrap_or_default()
}

/// Whether `origin` is one of the other sites' pages `setting` lists (`originAllowed`), compared exactly.
pub(crate) fn origin_allowed(setting: &str, origin: &str) -> bool {
    origin != "null" && !origin.is_empty() && setting.split(',').filter_map(as_origin).any(|o| o == origin)
}

/// A query's value, when it's given once: as `getQuery` reads it, a repeated one is a list, so not a string.
pub fn query_value(query: &[(String, String)], name: &str) -> Option<String> {
    let mut found = query.iter().filter(|(key, _)| key == name);
    let (_, value) = found.next()?;
    found.next().is_none().then(|| value.clone())
}

pub fn parse_query(raw: Option<&str>) -> Vec<(String, String)> {
    url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()).into_owned().collect()
}

/// The cookie that keeps what the way back has to match, as `setCookie` writes it.
fn kept_cookie(value: &str, headers: &HeaderMap) -> String {
    format!("{COOKIE}={value}; Max-Age={KEPT_FOR}; Path={COOKIE_PATH}; HttpOnly;{} SameSite=Lax", if over_https(headers) { " Secure;" } else { "" })
}

/// The cookie that clears it again, as `deleteCookie` writes it.
pub fn cleared_cookie() -> String {
    format!("{COOKIE}=; Max-Age=0; Path={COOKIE_PATH}")
}

/// Where to send the browser to log in (`startOidc`), and the short http-only cookie with what the way back has to
/// match. `back` is the page's own origin when it's hosted on another site, which the callback returns to (ORR-667):
/// only a listed one.
pub async fn start(headers: &HeaderMap, invite: Option<String>, back: Option<String>) -> Result<(String, String)> {
    start_with(&needs_settings()?, &allowed_origins(), headers, invite, back).await
}

/// `start`, with the environment's settings already read, so tests needn't set them.
async fn start_with(settings: &Settings, allowed: &str, headers: &HeaderMap, invite: Option<String>, back: Option<String>) -> Result<(String, String)> {
    let Provider { authorization_endpoint, .. } = provider(settings).await?;
    let (state, nonce, verifier) = (random(), random(), random());
    let mut kept = Map::new();
    kept.insert("state".into(), json!(state));
    kept.insert("nonce".into(), json!(nonce));
    kept.insert("verifier".into(), json!(verifier));
    if let Some(invite) = invite {
        kept.insert("invite".into(), json!(invite));
    }
    if let Some(back) = back.filter(|b| origin_allowed(allowed, b)) {
        kept.insert("back".into(), json!(back));
    }
    let cookie = kept_cookie(&URL_SAFE_NO_PAD.encode(Value::Object(kept).to_string()), headers);
    let mut url = Url::parse(&authorization_endpoint).map_err(|_| ApiError::provider("The OIDC provider has to be on https"))?;
    url.set_query(None);
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("scope", "openid profile"),
        ("client_id", settings.client_id.as_str()),
        ("redirect_uri", redirect_uri(headers).as_str()),
        ("state", state.as_str()),
        ("nonce", nonce.as_str()),
        ("code_challenge", URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())).as_str()),
        ("code_challenge_method", "S256"),
    ]);
    Ok((url.to_string(), cookie))
}

fn refused(message: &str) -> ApiError {
    ApiError::unauthorized(message)
}

/// Who the provider vouches for on the way back (`finishOidc`).
pub struct Finished {
    pub issuer: String,
    pub subject: String,
    /// The name the provider gives (`name`, else `preferred_username`), for the first person in becoming the owner (ORR-1185).
    pub name: Option<String>,
    pub invite: Option<String>,
    pub back: Option<String>,
}

/// What `start` kept in its cookie; none when the cookie isn't that, as a browser can send anything.
fn read_kept(kept: &str) -> Option<Map<String, Value>> {
    let bytes = LENIENT.decode(kept).ok()?;
    match serde_json::from_slice::<Value>(&bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// The way back (`finishOidc`): checks it answers this browser's own request, swaps the code for an ID token, verifies
/// that against the provider's keys, and says who the provider vouches for, which invite this browser came with, and
/// the listed origin its page is on when that's another site's. The cookie is cleared whatever comes of it, by the
/// caller, as `deleteCookie` runs before anything is checked.
pub async fn finish(headers: &HeaderMap, state: Option<String>, code: Option<String>, kept: Option<String>) -> Result<Finished> {
    finish_with(&needs_settings()?, &allowed_origins(), headers, state, code, kept).await
}

/// `finish`, with the environment's settings already read, so tests needn't set them.
async fn finish_with(
    settings: &Settings,
    allowed: &str,
    headers: &HeaderMap,
    state: Option<String>,
    code: Option<String>,
    kept: Option<String>,
) -> Result<Finished> {
    let Some(kept) = kept else { return Err(refused("This login has run out: start again")) };
    let asked = read_kept(&kept);
    let mismatch = || refused("This login doesn't match the one this browser started");
    let asked = asked.ok_or_else(mismatch)?;
    let (Some(state), Some(code)) = (state, code) else { return Err(mismatch()) };
    if asked.get("state").and_then(Value::as_str) != Some(state.as_str()) {
        return Err(mismatch());
    }
    let text = |key: &str| asked.get(key).and_then(Value::as_str).map(str::to_owned);
    let Provider { token_endpoint, jwks_uri, issuer, token_endpoint_auth_methods_supported: methods, .. } = provider(settings).await?;
    let (basic, in_body) = client_auth(methods.as_deref(), &settings.client_id, &settings.client_secret);
    let verifier = text("verifier").unwrap_or_else(|| "undefined".into());
    let back_to = redirect_uri(headers);
    let mut form =
        vec![("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", back_to.as_str()), ("client_id", settings.client_id.as_str())];
    if in_body {
        form.push(("client_secret", settings.client_secret.as_str()));
    }
    form.push(("code_verifier", verifier.as_str()));
    let mut request = client()?.post(&token_endpoint).form(&form);
    if let Some(basic) = basic {
        request = request.header("Authorization", basic);
    }
    let answer: Value = fetch_json(request).await?;
    let Some(id_token) = answer.get("id_token").and_then(Value::as_str).filter(|t| !t.is_empty()) else {
        return Err(refused("The provider gave no ID token"));
    };
    let doesnt_check_out = || refused("The provider's ID token doesn't check out");
    let keys: JwkSet = fetch_json(client()?.get(&jwks_uri)).await.map_err(|_| doesnt_check_out())?;
    let claims = verified(id_token, &keys, &issuer, &settings.client_id).ok_or_else(doesnt_check_out)?;
    let subject = claims.get("sub").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    if claims.get("nonce") != asked.get("nonce") || asked.get("nonce").is_none() {
        return Err(doesnt_check_out());
    }
    let Some(subject) = subject else { return Err(doesnt_check_out()) };
    // `back` is checked again, as the list may have changed since the login started.
    let back = text("back").filter(|b| origin_allowed(allowed, b));
    let name =
        ["name", "preferred_username"].iter().find_map(|claim| claims.get(*claim).and_then(Value::as_str).filter(|n| !n.trim().is_empty())).map(str::to_owned);
    Ok(Finished { issuer: trimmed(&issuer).to_owned(), subject, name, invite: text("invite").filter(|i| !i.is_empty()), back })
}

/// The ID token's claims, when it's signed by one of the provider's keys and is for this client from this issuer and
/// still current (as `jwtVerify` checks it). A token signed with no key (`none`) or a shared secret never is.
fn verified(token: &str, keys: &JwkSet, issuer: &str, client_id: &str) -> Option<Map<String, Value>> {
    let header = decode_header(token).ok()?;
    let candidates: Vec<_> = match &header.kid {
        Some(kid) => keys.keys.iter().filter(|k| k.common.key_id.as_deref() == Some(kid.as_str())).collect(),
        None => keys.keys.iter().collect(),
    };
    let [jwk] = candidates.as_slice() else { return None };
    if jwk.common.key_algorithm.is_some_and(|a| a.to_string() != format!("{:?}", header.alg)) {
        return None;
    }
    let key = DecodingKey::from_jwk(jwk).ok()?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[client_id]);
    validation.required_spec_claims = HashSet::new();
    validation.leeway = 0;
    validation.validate_nbf = true;
    decode::<Map<String, Value>>(token, &key, &validation).ok().map(|data| data.claims)
}

#[cfg(test)]
#[path = "oidc_tests.rs"]
mod provider_tests;

#[cfg(test)]
#[path = "oidc_reading_tests.rs"]
mod tests;
