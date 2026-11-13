use super::*;

#[test]
fn reads_since_as_a_date_does() {
    assert_eq!(time_of("2026-11-06T10:00:00+01:00").as_deref(), Some("2026-11-06T09:00:00.000Z"));
    assert_eq!(time_of("2026-11-06T09:00:00.5Z").as_deref(), Some("2026-11-06T09:00:00.500Z"));
    assert_eq!(time_of("2026-11-06").as_deref(), Some("2026-11-06T00:00:00.000Z"));
    assert_eq!(time_of("yesterday"), None);
}

#[test]
fn reads_numbers_as_the_route_does() {
    let asked = Asked::of(&HashMap::from([("before".into(), "12".into()), ("limit".into(), "x".into())]));
    assert_eq!(asked.before, Some(12.0));
    assert_eq!(asked.limit, None);
    assert_eq!(Asked::of(&HashMap::from([("before".into(), "0".into())])).before, None);
}
