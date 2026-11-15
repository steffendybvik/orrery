use super::*;

#[test]
fn short_ids() {
    assert_eq!(short_issue_id("ORR-12-x7k2m3qd", "x7k2m3qd").as_deref(), Some("ORR-12"));
    assert_eq!(short_issue_id("ORR-12-x7k2m3qd", "aaaaaaaa"), None);
}
