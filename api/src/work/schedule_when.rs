// When a schedule runs (ORR-1082): `when` and `nextRun` in web/server/utils/schedules.ts. Exactly one of a cron, a time
// to run once and an event, in a timezone orrery knows, and the next run worked out from it. The cron is read as croner
// reads it there: five fields, a day of the month or a weekday (either matches), and `sloppyRanges`, so `5/10` runs.
use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use croner::parser::CronParser;
use regex::Regex;
use std::sync::LazyLock;

/// An event's type, `*` for any part of it (`EVENT_PATTERN` in web/shared/happenings.ts).
static EVENT_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\*|[a-z][a-z0-9_-]*)(\.(\*|[a-z][a-z0-9_-]*))*$").unwrap());

/// When a schedule runs, checked.
#[derive(Debug, PartialEq)]
pub struct When {
    pub cron: Option<String>,
    pub at: Option<String>,
    pub on: Option<String>,
    pub timezone: String,
}

/// The zone used when none is given: the server's, as `Intl.DateTimeFormat().resolvedOptions().timeZone` has it, from `TZ`
/// here, or UTC.
fn server_zone() -> String {
    std::env::var("TZ").ok().filter(|tz| tz.parse::<Tz>().is_ok()).unwrap_or_else(|| "UTC".into())
}

fn zone(timezone: &str) -> Option<Tz> {
    Tz::from_str_insensitive(timezone).ok()
}

/// A value that's there and not empty, as JavaScript takes it as true.
fn given(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// A time as `toISOString()` writes it.
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Exactly one of a cron that parses, a time to run once (still ahead, when `strict`) and an event, in a known zone; or
/// what's wrong, as the Nuxt server words it.
pub fn when(cron: Option<&str>, at: Option<&str>, on: Option<&str>, timezone: Option<&str>, strict: bool) -> std::result::Result<When, String> {
    let timezone = given(timezone).map(str::to_string).unwrap_or_else(server_zone);
    if zone(&timezone).is_none() {
        return Err(format!("\"timezone\" is \"{timezone}\", not a timezone orrery knows (e.g. Europe/Oslo)"));
    }
    let cron = given(cron).map(|c| c.trim().to_string());
    let at = given(at).map(str::to_string);
    let on = given(on).map(|o| o.trim().to_string());
    let either = "Send one of \"cron\" (when it repeats), \"at\" (once) and \"on\" (an event)";
    if [cron.is_some(), at.is_some(), on.is_some()].iter().filter(|g| **g).count() > 1 {
        return Err(either.into());
    }
    if let Some(on) = on.filter(|o| !o.is_empty()) {
        if !EVENT_PATTERN.is_match(&on) {
            return Err(format!("\"on\" is \"{on}\"; use an event's type, with * for any part: issue.status, release.*, *.failed"));
        }
        return Ok(When { cron: None, at: None, on: Some(on), timezone });
    }
    if let Some(cron) = cron.filter(|c| !c.is_empty()) {
        if cron.split_whitespace().count() != 5 {
            return Err(format!("\"cron\" is \"{cron}\"; use five fields: minute hour day month weekday, e.g. \"0 9 * * 1-5\""));
        }
        if let Err(error) = parser().parse(&cron) {
            return Err(format!("\"cron\" is \"{cron}\": {error}"));
        }
        return Ok(When { cron: Some(cron), at: None, on: None, timezone });
    }
    let Some(at) = at else {
        return Err(either.into());
    };
    let Ok(time) = DateTime::parse_from_rfc3339(&at).map(|t| t.with_timezone(&Utc)) else {
        return Err(format!("\"at\" is \"{at}\", not a time (e.g. 2026-10-26T09:00:00+01:00)"));
    };
    if strict && time <= Utc::now() {
        return Err(format!("\"at\" is {}, which has passed", iso(time)));
    }
    Ok(When { cron: None, at: Some(iso(time)), on: None, timezone })
}

fn parser() -> CronParser {
    CronParser::builder().sloppy_ranges(true).build()
}

/// When it runs next after `from` (`nextRun`): the cron's next time, or a one-off's time if that's still ahead.
pub fn next_run(when: &When, from: DateTime<Utc>) -> Option<String> {
    if let Some(at) = &when.at {
        let time = DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Utc);
        return (time > from).then(|| at.clone());
    }
    let cron = parser().parse(when.cron.as_deref()?).ok()?;
    let tz = zone(&when.timezone)?;
    let next = cron.find_next_occurrence(&from.with_timezone(&tz), false).ok()?;
    Some(iso(next.with_timezone(&Utc)))
}

#[cfg(test)]
mod tests {
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
}
