use super::*;

#[test]
fn hashes_as_the_store_does() {
    assert_eq!(hash_of("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

#[test]
fn holds_keys_to_a_person() {
    let session = Actor { name: "agent".into(), owner: false, session: Some("s".into()), ..Default::default() };
    let owner = Actor { name: "Steffen".into(), owner: true, session: None, ..Default::default() };
    let browser = Who { person: "ada".into(), owner: false, browser: true };
    let agent = Who { person: "steffen".into(), owner: true, browser: false };
    assert_eq!(holder_of("keys.write", Some(&browser), &session).unwrap(), ("ada".into(), false));
    assert_eq!(holder_of("keys.write", None, &owner).unwrap(), ("steffen".into(), true));
    assert_eq!(holder_of("keys.write", None, &session).unwrap_err().status.as_u16(), 403);
    assert_eq!(holder_of("logins.write", Some(&agent), &owner).unwrap_err().status.as_u16(), 403);
}

#[test]
fn reads_a_field_as_javascript_would() {
    assert_eq!(js_string(Some(&json!(12))), "12");
    assert_eq!(js_string(Some(&json!(null))), "");
    assert_eq!(js_string(Some(&json!({"a": 1}))), "[object Object]");
}
