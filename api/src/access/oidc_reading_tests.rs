// What the provider login reads from a request and its settings, no provider needed.
use super::*;

#[test]
fn reads_an_origin_as_the_browser_sends_it() {
    assert_eq!(as_origin(" https://app.example.com/ ").as_deref(), Some("https://app.example.com"));
    assert_eq!(as_origin("http://localhost:3300").as_deref(), Some("http://localhost:3300"));
    for not in ["ftp://x.example", "https://u:p@x.example", "https://x.example/path", "https://x.example/?q=1", "null", ""] {
        assert_eq!(as_origin(not), None, "{not}");
    }
}

#[test]
fn keeps_the_provider_on_https_but_on_this_machine() {
    assert!(secure("https://id.example").is_ok());
    assert!(secure("http://127.0.0.1:8080").is_ok());
    assert!(secure("http://localhost/x").is_ok());
    assert!(secure("http://id.example").is_err());
    assert!(secure("http://127.0.0.1.example").is_err());
}

#[test]
fn reads_a_query_value_given_once() {
    let query = parse_query(Some("invite=a&back=b&back=c&x=%20y+z"));
    assert_eq!(query_value(&query, "invite").as_deref(), Some("a"));
    assert_eq!(query_value(&query, "back"), None);
    assert_eq!(query_value(&query, "x").as_deref(), Some(" y z"));
    assert_eq!(query_value(&query, "none"), None);
}

#[test]
fn reads_only_what_start_kept() {
    let kept = URL_SAFE_NO_PAD.encode(r#"{"state":"s","nonce":"n"}"#);
    assert_eq!(read_kept(&kept).unwrap().get("state"), Some(&json!("s")));
    assert!(read_kept(&URL_SAFE_NO_PAD.encode("null")).is_none());
    assert!(read_kept("not base64 !").is_none());
}
