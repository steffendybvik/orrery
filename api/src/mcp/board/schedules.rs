// The chat's `schedules` tool at `/mcp` (ORR-1100), as channel/tools.mjs runs it: the project's schedules from its
// route, a line each. Making and changing one (`create_schedule`, `update_schedule`) and `update_settings` are asks:
// the chat's through its chat (`utils/chats.ts`, still Node's) and a work session's on its issue
// (`…/schedule-requests`, which waits on ORR-1082), so they follow those.
use super::{text, truthy, Api, Said};
use axum::http::Method;
use serde_json::Value;

/// When a schedule runs, as the channel's `when`: on an event (with its filter), a cron, once, or never.
fn when(s: &Value) -> String {
    if truthy(&s["on"]) {
        let filter = s["on_filter"].as_object().filter(|f| !f.is_empty()).map(|f| format!(" {}", Value::Object(f.clone()))).unwrap_or_default();
        format!("on {}{filter}", text(&s["on"]))
    } else if truthy(&s["cron"]) {
        format!("{} ({})", text(&s["cron"]), text(&s["timezone"]))
    } else if truthy(&s["at"]) {
        format!("once at {}", text(&s["at"]))
    } else {
        "never".into()
    }
}

/// Its last run, as the channel's `last`.
fn last(s: &Value) -> String {
    let Some(run) = s["runs"].as_array().and_then(|r| r.first()) else { return "never run".into() };
    let issue = if truthy(&run["issue"]) { format!(" {}", text(&run["issue"])) } else { String::new() };
    let note = if truthy(&run["note"]) { format!(" ({})", text(&run["note"])) } else { String::new() };
    format!("last {} {}{issue}{note}", text(&run["at"]), text(&run["outcome"]))
}

fn line(s: &Value) -> String {
    let untrusted = if truthy(&s["untrusted"]) { ", untrusted" } else { "" };
    let presets: Vec<String> = s["presets"].as_array().into_iter().flatten().map(text).collect();
    let presets = if presets.is_empty() { String::new() } else { format!(", presets {}", presets.join(", ")) };
    let next = if truthy(&s["next_run"]) { format!("; next {}", text(&s["next_run"])) } else { String::new() };
    format!(
        "{}: {} [{}, {}{untrusted}] {}{presets}; {}{next}",
        text(&s["id"]),
        text(&s["title"]),
        text(&s["kind"]),
        if truthy(&s["enabled"]) { "on" } else { "paused" },
        when(s),
        last(s)
    )
}

impl Api<'_> {
    pub(super) async fn schedules(&self, args: &Value) -> Said {
        let schedules = self.call(Method::GET, &format!("{}/schedules", self.at(&self.project_of(args)?)), None).await?;
        let lines: Vec<String> = schedules.as_array().into_iter().flatten().map(line).collect();
        Ok(if lines.is_empty() { "No schedules yet.".into() } else { lines.join("\n") })
    }
}

#[cfg(test)]
#[path = "schedules_tests.rs"]
mod tests;
