// The browser guards as the router's writes.ts holds them (ORR-1173), at the function; request_tests.rs knocks on the door.
use super::*;
use axum::http::HeaderValue;

fn allowed(hosts: &str, origins: &str) -> Allowed {
    Allowed { hosts: hosts.into(), origins: origins.into() }
}

fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.insert(*name, HeaderValue::from_str(value).unwrap());
    }
    map
}

fn status(result: Result<()>) -> Option<u16> {
    result.err().map(|e| e.status.as_u16())
}

#[test]
fn answers_only_the_names_this_machine_goes_by() {
    let none = allowed("", "");
    for host in ["localhost%3A9000", "orrery.localhost", "my-mac.local%3A9000", "192.168.1.20%3A9000", "%5B%3A%3A1%5D%3A9000"] {
        assert_eq!(status(browser_checked(&none, &headers(&[("orrery-host", host)]), "GET", "/api/projects")), None, "{host}");
    }
    for host in ["evil.example", "a.b.local", "rebind.example%3A9000"] {
        assert_eq!(status(browser_checked(&none, &headers(&[("orrery-host", host)]), "GET", "/api/projects")), Some(403), "{host}");
    }
    assert_eq!(status(browser_checked(&allowed("Orrery.lan", ""), &headers(&[("orrery-host", "orrery.lan%3A9000")]), "GET", "/api/projects")), None);
}

#[test]
fn takes_writes_from_its_own_page_or_a_listed_site_alone() {
    let host = ("orrery-host", "localhost%3A9000");
    let write = |a: &Allowed, origin: &str| status(browser_checked(a, &headers(&[host, ("orrery-sent-origin", origin)]), "POST", "/api/projects/shop/issues"));
    let none = allowed("", "");
    assert_eq!(write(&none, "http%3A%2F%2Flocalhost%3A9000"), None);
    assert_eq!(write(&none, "http%3A%2F%2Fevil.example"), Some(403));
    assert_eq!(write(&none, "http%3A%2F%2Flocalhost%3A9001"), Some(403));
    assert_eq!(write(&none, "null"), Some(403));
    assert_eq!(write(&none, "foo"), Some(403));
    assert_eq!(write(&allowed("", "https://app.example.com"), "https%3A%2F%2Fapp.example.com"), None);
    // `null` is never a listed site, whatever the setting holds.
    assert_eq!(write(&allowed("", "null"), "null"), Some(403));
    // Agents, curl and the channel send none; a read isn't a write.
    assert_eq!(status(browser_checked(&none, &headers(&[host]), "POST", "/api/projects/shop/issues")), None);
    assert_eq!(status(browser_checked(&none, &headers(&[host, ("orrery-sent-origin", "http%3A%2F%2Fevil.example")]), "GET", "/api/projects")), None);
}

#[test]
fn wants_a_writes_body_as_json() {
    let host = ("orrery-host", "localhost%3A9000");
    let none = allowed("", "");
    let post = |pairs: &[(&'static str, &str)]| status(browser_checked(&none, &headers(pairs), "POST", "/api/projects/shop/issues"));
    assert_eq!(post(&[host, ("content-length", "12"), ("content-type", "text/plain")]), Some(415));
    assert_eq!(post(&[host, ("content-length", "12"), ("content-type", "application/x-www-form-urlencoded")]), Some(415));
    assert_eq!(post(&[host, ("content-length", "12"), ("content-type", "application/json; charset=utf-8")]), None);
    assert_eq!(post(&[host, ("content-length", "0"), ("content-type", "text/plain")]), None);
}

#[test]
fn leaves_a_request_that_didnt_come_through_the_routers_door() {
    assert_eq!(
        status(browser_checked(&allowed("", ""), &headers(&[("orrery-sent-origin", "http%3A%2F%2Fevil.example")]), "POST", "/api/projects/shop/issues")),
        None
    );
}
