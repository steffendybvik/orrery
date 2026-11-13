use super::*;

fn at(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
}

fn cron(cron: &str, timezone: &str) -> When {
    when(Some(cron), None, None, Some(timezone), false).unwrap()
}

#[test]
fn a_cron_runs_next_in_its_own_zone() {
    // 09:00 on a weekday in Oslo is 08:00 UTC in winter; a Saturday waits for Monday.
    assert_eq!(next_run(&cron("0 9 * * 1-5", "Europe/Oslo"), at("2026-11-07T10:00:00Z")).as_deref(), Some("2026-11-09T08:00:00.000Z"));
    assert_eq!(next_run(&cron("0 9 * * 1-5", "UTC"), at("2026-11-09T08:59:30Z")).as_deref(), Some("2026-11-09T09:00:00.000Z"));
    // Not the minute it's at: the next one.
    assert_eq!(next_run(&cron("* * * * *", "UTC"), at("2026-11-09T09:00:00Z")).as_deref(), Some("2026-11-09T09:01:00.000Z"));
}

#[test]
fn a_day_of_the_month_or_a_weekday_either_runs_it() {
    // The 15th, or any Monday: the Monday comes first.
    assert_eq!(next_run(&cron("0 0 15 * 1", "UTC"), at("2026-11-08T12:00:00Z")).as_deref(), Some("2026-11-09T00:00:00.000Z"));
}

#[test]
fn a_step_after_a_number_still_parses() {
    assert_eq!(next_run(&cron("5/10 * * * *", "UTC"), at("2026-11-09T09:00:00Z")).as_deref(), Some("2026-11-09T09:05:00.000Z"));
}

#[test]
fn a_one_off_runs_only_while_its_time_is_ahead() {
    let once = when(None, Some("2026-12-01T10:00:00+01:00"), None, Some("Europe/Oslo"), false).unwrap();
    assert_eq!(once.at.as_deref(), Some("2026-12-01T09:00:00.000Z"));
    assert_eq!(next_run(&once, at("2026-11-08T00:00:00Z")).as_deref(), Some("2026-12-01T09:00:00.000Z"));
    assert_eq!(next_run(&once, at("2026-12-02T00:00:00Z")), None);
    assert_eq!(when(None, Some("2020-01-01T00:00:00Z"), None, Some("UTC"), true).unwrap_err(), "\"at\" is 2020-01-01T00:00:00.000Z, which has passed");
}

#[test]
fn an_event_has_no_next_run() {
    let on = when(None, None, Some(" issue.status "), Some("UTC"), true).unwrap();
    assert_eq!(on.on.as_deref(), Some("issue.status"));
    assert_eq!(next_run(&on, Utc::now()), None);
    assert!(when(None, None, Some("Issue status"), Some("UTC"), true).unwrap_err().starts_with("\"on\" is \"Issue status\"; use an event's type"));
}

#[test]
fn what_doesnt_make_a_time_is_said() {
    let either = "Send one of \"cron\" (when it repeats), \"at\" (once) and \"on\" (an event)";
    assert_eq!(when(None, None, None, Some("UTC"), false).unwrap_err(), either);
    assert_eq!(when(Some("0 9 * * *"), None, Some("issue.status"), Some("UTC"), false).unwrap_err(), either);
    assert_eq!(
        when(Some("0 9 * *"), None, None, Some("UTC"), false).unwrap_err(),
        "\"cron\" is \"0 9 * *\"; use five fields: minute hour day month weekday, e.g. \"0 9 * * 1-5\""
    );
    assert!(when(Some("0 25 * * *"), None, None, Some("UTC"), false).unwrap_err().starts_with("\"cron\" is \"0 25 * * *\": "));
    assert_eq!(
        when(Some("0 9 * * *"), None, None, Some("Mars/Olympus"), false).unwrap_err(),
        "\"timezone\" is \"Mars/Olympus\", not a timezone orrery knows (e.g. Europe/Oslo)"
    );
    assert_eq!(when(None, Some("tomorrow"), None, Some("UTC"), false).unwrap_err(), "\"at\" is \"tomorrow\", not a time (e.g. 2026-10-26T09:00:00+01:00)");
}

#[test]
fn names_utc_as_intl_does() {
    for zone in ["Etc/UTC", "Etc/GMT", "Zulu", "UCT", "UTC"] {
        assert_eq!(utc_named(zone.into()), "UTC", "{zone}");
    }
    assert_eq!(utc_named("Europe/Oslo".into()), "Europe/Oslo");
}
