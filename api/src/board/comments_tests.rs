use super::*;

#[test]
fn ids() {
    assert_eq!(comment_id("12").unwrap(), 12);
    assert_eq!(comment_id(" 12.0 ").unwrap(), 12);
    assert!(comment_id("abc").is_err() && comment_id("1.5").is_err() && comment_id("").is_err());
}
