use super::*;

fn said(pairs: &[(&'static str, &str)]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        headers.insert(*name, HeaderValue::from_str(value).unwrap());
    }
    headers
}

#[test]
fn lists_are_joined_in_order_and_a_single_value_is_the_last_calls() {
    let relay = Relay::default();
    relay.keep(&said(&[("orrery-carry", "alpha ALP-1 3"), ("orrery-asked", "first"), ("orrery-api-token", "secret")]));
    relay.keep(&said(&[("orrery-carry", "alpha ALP-2 4"), ("orrery-asked", "second"), ("orrery-changed", "")]));
    let mut out = HeaderMap::new();
    relay.onto(&mut out);
    assert_eq!(out.get("orrery-carry").unwrap(), "alpha ALP-1 3, alpha ALP-2 4");
    assert_eq!(out.get("orrery-asked").unwrap(), "second");
    assert!(out.get("orrery-changed").is_none(), "an empty list says nothing");
    assert!(out.get("orrery-api-token").is_none(), "only what a write set off is handed back");
}
