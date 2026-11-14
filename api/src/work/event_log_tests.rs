use super::*;

#[test]
fn a_kind_is_a_dotted_name() {
    for kind in ["page.error", "session.started", "api.unreachable", "a", "issue.due_date", "x-y.z9"] {
        assert!(is_kind(kind), "{kind}");
    }
    for kind in ["", "Page.error", "page.", ".page", "page..error", "9page", "page error", "page.Error"] {
        assert!(!is_kind(kind), "{kind}");
    }
}

#[test]
fn a_long_text_is_cut_with_an_ellipsis() {
    assert_eq!(cut("short", 10), "short");
    assert_eq!(cut("abcdefghijk", 5), "abcd…");
    assert_eq!(cut("ééééé", 5), "ééééé", "characters, not bytes");
}

#[test]
fn a_limit_is_a_whole_number_from_one_to_a_thousand() {
    assert_eq!(limit_of(None), 200);
    assert_eq!(limit_of(Some(0.0)), 200, "Number('0') || undefined is the default");
    assert_eq!(limit_of(Some(f64::NAN)), 200);
    assert_eq!(limit_of(Some(5.7)), 5);
    assert_eq!(limit_of(Some(-3.0)), 1);
    assert_eq!(limit_of(Some(5000.0)), 1000);
    assert_eq!(limit_of(Some(f64::INFINITY)), 1000);
}

#[test]
fn since_is_a_time_with_its_zone_or_a_day() {
    assert_eq!(since_of("2026-10-27T09:00:00Z").unwrap(), "2026-10-27T09:00:00.000Z");
    assert_eq!(since_of("2026-10-27T11:00:00+02:00").unwrap(), "2026-10-27T09:00:00.000Z");
    assert_eq!(since_of("2026-10-27").unwrap(), "2026-10-27T00:00:00.000Z");
    assert_eq!(since_of("soon").unwrap_err().message, "\"since\" is \"soon\", not a time (e.g. 2026-10-27T09:00:00Z)");
}
