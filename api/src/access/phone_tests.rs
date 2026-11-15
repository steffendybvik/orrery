use super::*;

#[test]
fn a_link_is_good_once() {
    let links = Links::default();
    let made = links.make("steffen", 0);
    assert_eq!(links.take_link(Some(&made.token), 1), Some("steffen".into()));
    assert_eq!(links.take_link(Some(&made.token), 1), None);
    // Its code went with it.
    assert_eq!(links.take_code(Some(&made.code), 1), None);
}

#[test]
fn a_link_runs_out() {
    let links = Links::default();
    let made = links.make("steffen", 0);
    assert_eq!(links.take_link(Some(&made.token), LINK_MINUTES * 60_000), None);
}

#[test]
fn a_code_is_typed_loosely_and_uses_up_its_link() {
    let links = Links::default();
    let made = links.make("steffen", 0);
    let typed = format!("{}-{} ", made.code[..3].to_lowercase(), &made.code[3..]);
    assert_eq!(links.take_code(Some(&typed), 1), Some("steffen".into()));
    assert_eq!(links.take_link(Some(&made.token), 1), None);
    assert!(made.code.bytes().all(|b| LETTERS.contains(&b)) && made.code.len() == CODE_LENGTH);
}

#[test]
fn wrong_codes_in_a_row_end_every_code_but_not_the_links() {
    let links = Links::default();
    let made = links.make("steffen", 0);
    for _ in 0..WRONG_CODES {
        assert_eq!(links.take_code(Some("ZZZZZZ0"), 1), None);
    }
    assert_eq!(links.take_code(Some(&made.code), 1), None);
    assert_eq!(links.take_link(Some(&made.token), 1), Some("steffen".into()));
}

#[test]
fn a_misshapen_token_is_nobodys() {
    let links = Links::default();
    assert_eq!(links.take_link(Some("short"), 0), None);
    assert_eq!(links.take_link(None, 0), None);
}

#[test]
fn at_most_twenty_are_kept() {
    let links = Links::default();
    let first = links.make("steffen", 0);
    for _ in 0..MAX {
        links.make("steffen", 0);
    }
    assert_eq!(links.take_link(Some(&first.token), 1), None);
    assert_eq!(links.0.lock().unwrap().links.len(), MAX);
}
