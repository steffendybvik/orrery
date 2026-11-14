// Logging in through a provider (ORR-1124), against a stub of one on a local port: its discovery document, `/token`
// and a key set holding one RSA key the tests sign with. The settings are handed in, never read from the environment
// the other tests share. The key pair is made for these tests and guards nothing.
use super::*;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use std::sync::Arc;

const PRIVATE_KEY: &str = include_str!("oidc_test_key.pem");
const PUBLIC_KEY: &str = include_str!("oidc_test_key.pub.pem");
/// The key's modulus, as its JWK gives it.
const MODULUS: &str = "1XC6gv6EQ5l3LMrRfr-AKIB5MdQCzstB_FXX_k7QRQXup6A4jRlukamNhWvLMzUkpUcrcno93ooV8ExjF1RRx6fZKPxG-KCWLFP33D0NKnKPXQ27XDkg26Q8XmVROEv5sS7wsrC9veeIYNkMzb5gHTZDruzwBBAxELK5hA41MhOsLqf0iNJTlgqEBKSQL2JCDos8m8myaoUqf2_LWhZjakJsqqY9N0C8T4rtL43tpz287ujtu3mk9tP5oef0QmrZw__DnYf11pUueBJnGyf7e4WMcKxEHRIsuv5C9XkNL6xvNGC4G-8353jGdX0ARAN8iUWlnOyglvHsq9TCQCjCPw";
const ALLOWED: &str = "https://app.example.com";

/// What the stub serves, and what it was asked.
struct Served {
    discovery: Value,
    token: Value,
    keys: Value,
    found: usize,
    forms: Vec<Vec<(String, String)>>,
    auths: Vec<Option<String>>,
}

type Shared = Arc<Mutex<Served>>;

struct Stub {
    base: String,
    served: Shared,
}

impl Stub {
    async fn new() -> Stub {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let served = Arc::new(Mutex::new(Served {
            discovery: json!({
                "issuer": base,
                "authorization_endpoint": format!("{base}/authorize?prompt=login"),
                "token_endpoint": format!("{base}/token"),
                "jwks_uri": format!("{base}/jwks"),
            }),
            token: json!({}),
            keys: json!({ "keys": [jwk("k1", Some("RS256"))] }),
            found: 0,
            forms: vec![],
            auths: vec![],
        }));
        let app = Router::new()
            .route(
                "/.well-known/openid-configuration",
                get(|State(s): State<Shared>| async move {
                    let mut s = s.lock().unwrap();
                    s.found += 1;
                    Json(s.discovery.clone())
                }),
            )
            .route(
                "/token",
                post(|State(s): State<Shared>, sent: HeaderMap, Form(form): Form<Vec<(String, String)>>| async move {
                    let mut s = s.lock().unwrap();
                    s.forms.push(form);
                    s.auths.push(sent.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_owned));
                    Json(s.token.clone())
                }),
            )
            .route("/jwks", get(|State(s): State<Shared>| async move { Json(s.lock().unwrap().keys.clone()) }))
            .with_state(served.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Stub { base, served }
    }

    fn settings(&self) -> Settings {
        Settings { issuer: format!("{}/", self.base), client_id: "orrery".into(), client_secret: "a-secret".into() }
    }

    fn set(&self, change: impl FnOnce(&mut Served)) {
        change(&mut self.served.lock().unwrap());
    }

    /// Claims that check out for this provider, with `nonce`.
    fn claims(&self, nonce: &str) -> Value {
        json!({ "iss": self.base, "aud": "orrery", "sub": "person-1", "nonce": nonce, "iat": now(), "exp": now() + 300 })
    }

    /// The provider answers `/token` with `id_token`.
    fn answers(&self, id_token: &str) {
        self.set(|s| s.token = json!({ "id_token": id_token, "access_token": "unused" }));
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn jwk(kid: &str, alg: Option<&str>) -> Value {
    let mut key = json!({ "kty": "RSA", "use": "sig", "kid": kid, "n": MODULUS, "e": "AQAB" });
    if let Some(alg) = alg {
        key["alg"] = json!(alg);
    }
    key
}

fn key_set(keys: &[Value]) -> JwkSet {
    serde_json::from_value(json!({ "keys": keys })).unwrap()
}

/// `claims` signed with the test key, under `kid`.
fn signed(claims: &Value, kid: Option<&str>) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = kid.map(str::to_owned);
    encode(&header, claims, &EncodingKey::from_rsa_pem(PRIVATE_KEY.as_bytes()).unwrap()).unwrap()
}

fn unsigned(claims: &Value) -> String {
    let part = |v: &Value| URL_SAFE_NO_PAD.encode(v.to_string());
    format!("{}.{}.", part(&json!({ "alg": "none", "typ": "JWT", "kid": "k1" })), part(claims))
}

fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        headers.insert(*name, value.parse().unwrap());
    }
    headers
}

fn kept(value: Value) -> Option<String> {
    Some(URL_SAFE_NO_PAD.encode(value.to_string()))
}

fn refusal<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("let through"),
        Err(e) => e.message,
    }
}

const DOESNT_CHECK_OUT: &str = "The provider's ID token doesn't check out";

// ---- verified: the ID token against the provider's keys ----

fn check(token: &str, keys: &JwkSet) -> Option<Map<String, Value>> {
    verified(token, keys, "https://id.example", "orrery")
}

fn good_claims() -> Value {
    json!({ "iss": "https://id.example", "aud": "orrery", "sub": "person-1", "exp": now() + 300 })
}

#[test]
fn a_token_signed_by_the_providers_key_checks_out() {
    let claims = check(&signed(&good_claims(), Some("k1")), &key_set(&[jwk("k1", Some("RS256"))])).unwrap();
    assert_eq!(claims.get("sub"), Some(&json!("person-1")));
    // A key that names no algorithm is taken for the header's, and a token with no kid for the only key there is.
    assert!(check(&signed(&good_claims(), Some("k1")), &key_set(&[jwk("k1", None)])).is_some());
    assert!(check(&signed(&good_claims(), None), &key_set(&[jwk("k1", None)])).is_some());
    // An audience given as a list counts when it holds this client.
    let listed = json!({ "iss": "https://id.example", "aud": ["other", "orrery"], "sub": "p", "exp": now() + 300 });
    assert!(check(&signed(&listed, Some("k1")), &key_set(&[jwk("k1", None)])).is_some());
}

#[test]
fn the_kid_picks_exactly_one_key() {
    let token = signed(&good_claims(), Some("k1"));
    assert!(check(&token, &key_set(&[jwk("k2", None)])).is_none(), "a kid the provider doesn't have");
    assert!(check(&token, &key_set(&[jwk("k1", None), jwk("k1", None)])).is_none(), "two keys under one kid");
    assert!(check(&signed(&good_claims(), None), &key_set(&[jwk("k1", None), jwk("k2", None)])).is_none(), "no kid, two keys");
    assert!(check(&token, &key_set(&[])).is_none(), "no keys");
}

#[test]
fn the_keys_algorithm_has_to_be_the_headers() {
    assert!(check(&signed(&good_claims(), Some("k1")), &key_set(&[jwk("k1", Some("RS512"))])).is_none());
}

#[test]
fn a_token_signed_with_no_key_never_checks_out() {
    assert!(check(&unsigned(&good_claims()), &key_set(&[jwk("k1", None)])).is_none());
    assert!(check(&unsigned(&good_claims()), &key_set(&[jwk("k1", Some("RS256"))])).is_none());
}

#[test]
fn a_token_signed_with_the_public_key_as_a_shared_secret_never_checks_out() {
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some("k1".into());
    for secret in [PUBLIC_KEY.as_bytes(), MODULUS.as_bytes()] {
        let token = encode(&header, &good_claims(), &EncodingKey::from_secret(secret)).unwrap();
        assert!(check(&token, &key_set(&[jwk("k1", None)])).is_none());
        assert!(check(&token, &key_set(&[jwk("k1", Some("RS256"))])).is_none());
    }
}

#[test]
fn a_token_for_another_issuer_or_client_never_checks_out() {
    let keys = key_set(&[jwk("k1", None)]);
    let with = |key: &str, value: Value| {
        let mut claims = good_claims();
        claims[key] = value;
        signed(&claims, Some("k1"))
    };
    assert!(check(&with("iss", json!("https://other.example")), &keys).is_none());
    assert!(check(&with("aud", json!("someone-else")), &keys).is_none());
    assert!(check(&with("aud", json!(["someone-else"])), &keys).is_none());
}

#[test]
fn a_token_out_of_date_never_checks_out_not_even_by_a_second() {
    let keys = key_set(&[jwk("k1", None)]);
    let with = |key: &str, value: i64| {
        let mut claims = good_claims();
        claims[key] = json!(value);
        signed(&claims, Some("k1"))
    };
    assert!(check(&with("exp", now() - 1), &keys).is_none(), "expired a second ago");
    assert!(check(&with("nbf", now() + 5), &keys).is_none(), "good in five seconds");
    assert!(check(&with("nbf", now() - 5), &keys).is_some(), "good since five seconds ago");
}

#[test]
fn a_token_tampered_with_never_checks_out() {
    let token = signed(&good_claims(), Some("k1"));
    let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
    let mut claims = good_claims();
    claims["sub"] = json!("someone-else");
    parts[1] = URL_SAFE_NO_PAD.encode(claims.to_string());
    assert!(check(&parts.join("."), &key_set(&[jwk("k1", None)])).is_none());
    assert!(check("not a token", &key_set(&[jwk("k1", None)])).is_none());
}

// ---- provider: the discovery document ----

#[tokio::test]
async fn the_providers_endpoints_come_from_its_discovery_kept_for_an_hour() {
    let stub = Stub::new().await;
    let found = provider(&stub.settings()).await.unwrap();
    assert_eq!(found.token_endpoint, format!("{}/token", stub.base));
    provider(&stub.settings()).await.unwrap();
    assert_eq!(stub.served.lock().unwrap().found, 1, "the second read is the kept one");
}

#[tokio::test]
async fn a_provider_naming_another_issuer_is_refused() {
    let stub = Stub::new().await;
    stub.set(|s| s.discovery["issuer"] = json!("https://other.example"));
    assert_eq!(refusal(provider(&stub.settings()).await), "The OIDC provider gives a different issuer from the one set");
}

#[tokio::test]
async fn a_provider_with_an_endpoint_off_https_is_refused() {
    for endpoint in ["authorization_endpoint", "token_endpoint", "jwks_uri"] {
        let stub = Stub::new().await;
        stub.set(|s| s.discovery[endpoint] = json!("http://id.example/x"));
        assert_eq!(refusal(provider(&stub.settings()).await), "The OIDC provider has to be on https", "{endpoint}");
    }
    let off = Settings { issuer: "http://id.example".into(), client_id: "orrery".into(), client_secret: "s".into() };
    assert_eq!(refusal(provider(&off).await), "The OIDC provider has to be on https");
}

// ---- start: where the browser is sent ----

fn cookie_value(cookie: &str) -> String {
    cookie.strip_prefix("orrery_oidc=").unwrap().split(';').next().unwrap().to_owned()
}

#[tokio::test]
async fn start_sends_the_browser_with_a_state_nonce_and_s256_challenge_it_keeps() {
    let stub = Stub::new().await;
    let at = headers(&[("host", "inside:3300"), ("x-forwarded-host", "orrery.example"), ("x-forwarded-proto", "https")]);
    let (to, cookie) = start_with(&stub.settings(), ALLOWED, &at, Some("inv".into()), Some(ALLOWED.into())).await.unwrap();
    let to = Url::parse(&to).unwrap();
    assert_eq!(format!("{}{}", stub.base, to.path()), format!("{}/authorize", stub.base));
    let query: HashMap<String, String> = to.query_pairs().into_owned().collect();
    assert!(!query.contains_key("prompt"), "the endpoint's own query is replaced");
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["scope"], "openid");
    assert_eq!(query["client_id"], "orrery");
    assert_eq!(query["redirect_uri"], "https://orrery.example/api/auth/oidc/callback");
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(cookie.contains("HttpOnly;") && cookie.contains("Secure;") && cookie.contains("Path=/api/auth/oidc;"), "{cookie}");
    let kept = read_kept(&cookie_value(&cookie)).unwrap();
    let text = |key: &str| kept[key].as_str().unwrap().to_owned();
    assert_eq!(query["state"], text("state"));
    assert_eq!(query["nonce"], text("nonce"));
    assert_eq!(query["code_challenge"], URL_SAFE_NO_PAD.encode(Sha256::digest(text("verifier").as_bytes())));
    assert_eq!(text("invite"), "inv");
    assert_eq!(text("back"), ALLOWED);
    assert!(![text("state"), text("nonce")].contains(&text("verifier")), "each is its own");
}

#[tokio::test]
async fn start_keeps_back_only_when_its_an_allowed_origin() {
    let stub = Stub::new().await;
    let at = headers(&[("host", "localhost:9010")]);
    for back in ["https://evil.example", "https://app.example.com/page", "null", ""] {
        let (_, cookie) = start_with(&stub.settings(), ALLOWED, &at, None, Some(back.into())).await.unwrap();
        let kept = read_kept(&cookie_value(&cookie)).unwrap();
        assert!(!kept.contains_key("back"), "{back}");
        assert!(!kept.contains_key("invite"));
        assert!(!cookie.contains("Secure"), "plain http: {cookie}");
    }
    let (to, _) = start_with(&stub.settings(), ALLOWED, &at, None, None).await.unwrap();
    assert!(to.contains(&format!("redirect_uri={}", "http%3A%2F%2Flocalhost%3A9010%2Fapi%2Fauth%2Foidc%2Fcallback")), "{to}");
}

// ---- finish: the way back ----

struct WayBack {
    stub: Stub,
    kept: Value,
}

impl WayBack {
    async fn new() -> WayBack {
        let stub = Stub::new().await;
        stub.answers(&signed(&stub.claims("n"), Some("k1")));
        WayBack { stub, kept: json!({ "state": "s", "nonce": "n", "verifier": "v", "invite": "inv", "back": ALLOWED }) }
    }

    async fn finish_allowing(&self, allowed: &str) -> Result<Finished> {
        let at = headers(&[("host", "orrery.example")]);
        finish_with(&self.stub.settings(), allowed, &at, Some("s".into()), Some("the-code".into()), kept(self.kept.clone())).await
    }

    async fn finish(&self) -> Result<Finished> {
        self.finish_allowing(ALLOWED).await
    }
}

#[tokio::test]
async fn a_good_token_logs_in_after_swapping_the_code_with_pkces_verifier() {
    let way = WayBack::new().await;
    let Ok(found) = way.finish().await else { panic!("refused") };
    assert_eq!(found.issuer, way.stub.base, "the issuer as set, without its slash");
    assert_eq!(found.subject, "person-1");
    assert_eq!(found.invite.as_deref(), Some("inv"));
    assert_eq!(found.back.as_deref(), Some(ALLOWED));
    let forms = way.stub.served.lock().unwrap().forms.clone();
    let form: HashMap<_, _> = forms.into_iter().next().unwrap().into_iter().collect();
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["code"], "the-code");
    assert_eq!(form["code_verifier"], "v");
    assert_eq!(form["redirect_uri"], "http://orrery.example/api/auth/oidc/callback");
    assert_eq!(form["client_id"], "orrery");
    assert!(!form.contains_key("client_secret"), "the secret goes as HTTP Basic, not in the body (ORR-1181)");
    let auths = way.stub.served.lock().unwrap().auths.clone();
    assert_eq!(auths[0].as_deref(), Some(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("orrery:a-secret")).as_str()));
}

#[test]
fn the_secret_goes_in_the_body_only_to_a_provider_that_names_post_and_not_basic() {
    let post = vec!["client_secret_post".to_string()];
    assert_eq!(client_auth(Some(&post), "orrery", "s"), (None, true));
    let both = vec!["client_secret_post".to_string(), "client_secret_basic".to_string()];
    assert!(client_auth(Some(&both), "orrery", "s").0.is_some());
    assert!(client_auth(None, "orrery", "s").0.is_some());
}

#[test]
fn basic_form_encodes_the_id_and_secret_first() {
    let (header, in_body) = client_auth(None, "my app", "a:b/c+d");
    let encoded = header.unwrap().strip_prefix("Basic ").unwrap().to_owned();
    let pair = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
    assert_eq!(String::from_utf8(pair).unwrap(), "my+app:a%3Ab%2Fc%2Bd");
    assert!(!in_body);
}

#[tokio::test]
async fn a_state_that_isnt_this_browsers_never_reaches_the_provider() {
    let mut way = WayBack::new().await;
    way.kept["state"] = json!("other");
    assert_eq!(refusal(way.finish().await), "This login doesn't match the one this browser started");
    assert!(way.stub.served.lock().unwrap().forms.is_empty());
}

#[tokio::test]
async fn no_id_token_is_refused() {
    let way = WayBack::new().await;
    way.stub.set(|s| s.token = json!({ "access_token": "only" }));
    assert_eq!(refusal(way.finish().await), "The provider gave no ID token");
    way.stub.set(|s| s.token = json!({ "id_token": "" }));
    assert_eq!(refusal(way.finish().await), "The provider gave no ID token");
}

#[tokio::test]
async fn a_nonce_missing_or_different_is_refused() {
    let mut way = WayBack::new().await;
    way.stub.answers(&signed(&way.stub.claims("someone-elses"), Some("k1")));
    assert_eq!(refusal(way.finish().await), DOESNT_CHECK_OUT, "a different nonce");
    let mut claims = way.stub.claims("n");
    claims.as_object_mut().unwrap().remove("nonce");
    way.stub.answers(&signed(&claims, Some("k1")));
    assert_eq!(refusal(way.finish().await), DOESNT_CHECK_OUT, "the token has none");
    way.kept.as_object_mut().unwrap().remove("nonce");
    assert_eq!(refusal(way.finish().await), DOESNT_CHECK_OUT, "neither has one");
}

#[tokio::test]
async fn no_subject_is_refused() {
    let way = WayBack::new().await;
    for sub in [None, Some(json!("")), Some(json!(7))] {
        let mut claims = way.stub.claims("n");
        match sub {
            Some(sub) => claims["sub"] = sub,
            None => drop(claims.as_object_mut().unwrap().remove("sub")),
        }
        way.stub.answers(&signed(&claims, Some("k1")));
        assert_eq!(refusal(way.finish().await), DOESNT_CHECK_OUT);
    }
}

#[tokio::test]
async fn a_token_the_providers_keys_dont_vouch_for_is_refused() {
    let way = WayBack::new().await;
    way.stub.answers(&unsigned(&way.stub.claims("n")));
    assert_eq!(refusal(way.finish().await), DOESNT_CHECK_OUT, "alg none");
    way.stub.answers(&signed(&way.stub.claims("n"), Some("k2")));
    assert_eq!(refusal(way.finish().await), DOESNT_CHECK_OUT, "a kid it doesn't have");
    let mut claims = way.stub.claims("n");
    claims["aud"] = json!("someone-else");
    way.stub.answers(&signed(&claims, Some("k1")));
    assert_eq!(refusal(way.finish().await), DOESNT_CHECK_OUT, "for another client");
    way.stub.answers(&signed(&way.stub.claims("n"), Some("k1")));
    way.stub.set(|s| s.keys = json!("not a key set"));
    assert_eq!(refusal(way.finish().await), DOESNT_CHECK_OUT, "a key set that isn't one");
}

#[tokio::test]
async fn back_is_checked_again_on_the_way_back() {
    let way = WayBack::new().await;
    let Ok(found) = way.finish_allowing("https://another.example").await else { panic!("refused") };
    assert_eq!(found.back, None, "no longer allowed, so it's dropped");
    assert_eq!(found.subject, "person-1", "the login itself still stands");
}
