// Unit tests of work/chats.rs for what no route shows on its own (ORR-1324): how a release's place reads, and what a
// move's writes set off adding up without repeats.
use super::*;

#[test]
fn a_releases_place_reads_as_an_ordinal_from_the_top() {
    let read: Vec<String> = [-1.0, 0.0, 0.5, 1.0, 2.0, 3.0, 10.0, 11.0, 12.0, 20.0, 21.0, 22.0, 100.0, 110.0].into_iter().map(place).collect();
    assert_eq!(
        read,
        [
            "the top",
            "the top",
            "1st from the top",
            "2nd from the top",
            "3rd from the top",
            "4th from the top",
            "11th from the top",
            "12th from the top",
            "13th from the top",
            "21st from the top",
            "22nd from the top",
            "23rd from the top",
            "101st from the top",
            "111th from the top",
        ]
    );
}

#[test]
fn what_more_set_off_is_added_once_each() {
    let mut effects = Effects { changed: vec!["primes".into()], chats: vec!["c1".into()], ..Effects::default() };
    let more = Effects { changed: vec!["primes".into(), "evens".into()], chats: vec!["c1".into(), "c2".into()], ..Effects::default() };
    absorb(&mut effects, more);
    assert_eq!(effects.changed, ["primes", "evens"]);
    assert_eq!(effects.chats, ["c1", "c2"]);
}

#[test]
fn text_of_reads_a_string_as_itself_nothing_as_empty_and_anything_else_as_json() {
    assert_eq!(text_of(&json!("PRI-1")), "PRI-1");
    assert_eq!(text_of(&Value::Null), "");
    assert_eq!(text_of(&json!(3)), "3");
    assert_eq!(text_of(&json!({"a": 1})), "{\"a\":1}");
}
