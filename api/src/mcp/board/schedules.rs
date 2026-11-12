// The `schedules` tool at `/mcp` (ORR-1100), as channel/tools.mjs runs it: the project's schedules from its route, a
// line each. Making and changing one (`create_schedule`, `update_schedule`) are asks: a work session's on its issue
// (`…/schedule-requests`, `askOnIssue`), and the chat's, through its `request`, in its chat (`/api/chats/:chat/
// schedule-requests`). The chat's `update_settings`, `create_doc` and `update_doc` are asked in its chat too. Either chat ask is kept in the chat it
// names (`Orrery-Launch`, as the channel sends it), which the local app hears and the owner answers. So is the chat's
// `create_release` and `update_release` (`/api/chats/:chat/release-requests`) and its `offer_issue`
// (`…/issue-requests`), kept beside them here, and its `move_issues` (`…/move-requests`), which moves them at once when
// the owner's last message named them.
// The chat's `reply` goes in that chat the same way (`/api/chats/:chat/replies`, ORR-1101).
use super::{text, truthy, Api, Said};
use axum::http::Method;
use serde_json::{json, Value};

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
    /// A working session's `create_schedule`, or `update_schedule` with `schedule_id`: asked on its issue `id`
    /// (`askOnIssue`). None for the chat, whose asks go in its chat.
    pub(super) async fn ask_schedule(&self, args: &Value) -> Option<Said> {
        if crate::request::actor_of(self.headers).chat {
            return None;
        }
        Some(self.ask_on_issue(args).await)
    }

    async fn ask_on_issue(&self, args: &Value) -> Said {
        let id = text(&args["id"]);
        let project = self.project_of_issue(&json!({"id": id})).await?;
        let change = args.get("schedule_id").filter(|s| !s.is_null());
        let mut body = json!({"schedule": args.get("schedule").cloned().unwrap_or(Value::Null)});
        if let Some(schedule) = change {
            body["id"] = schedule.clone();
        }
        if let Some(why) = args.get("why").filter(|w| truthy(w)) {
            body["why"] = why.clone();
        }
        let asked = self.call(Method::POST, &format!("{}/schedule-requests", self.issue_path(&project, &id)), Some(body)).await?;
        Ok(format!(
            "Asked on {id} (comment {}): the owner sees the {} with Allow and Deny, and their answer comes back as a comment. Nothing is saved until they allow it.",
            text(&asked["id"]),
            if change.is_some() { "change" } else { "schedule" }
        ))
    }

    /// The chat this session is, as `Orrery-Launch` names it; refused for `tool` when it names none.
    fn chat(&self, tool: &str) -> std::result::Result<String, super::No> {
        match crate::request::header(self.headers, "orrery-launch").map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
            Some(chat) => Ok(chat),
            None => Err(super::No(format!("{tool} is the owner's chat's, and this session says no chat (Orrery-Launch)"))),
        }
    }

    /// The chat's `create_<kind>`, or `update_<kind>` by `id` (`change`), for a schedule or a doc: `fields` as its
    /// `request` sends them, the thing's fields beside `project` and `why`. Asked in its chat (`…/<kind>-requests`), on
    /// the project it names, which saves nothing until the owner allows it. A project this server doesn't serve is
    /// refused, as the channel's `on` refuses it.
    pub(super) async fn ask_in_chat(&self, kind: &str, change: bool, fields: &Value) -> Said {
        let chat = self.chat(&format!("{}_{kind}", if change { "update" } else { "create" }))?;
        let mut asked = fields.as_object().cloned().unwrap_or_default();
        let id = asked.shift_remove("id");
        let why = asked.shift_remove("why").filter(truthy);
        let project = self.reached(asked.shift_remove("project").filter(truthy))?;
        let mut body = json!({ kind: asked });
        if change {
            body["id"] = id.unwrap_or(Value::Null);
        }
        if let Some(project) = project {
            body["project"] = project;
        }
        if let Some(why) = why {
            body["why"] = why;
        }
        self.call(Method::POST, &format!("/api/chats/{}/{kind}-requests", super::enc(&chat)), Some(body)).await?;
        Ok(format!(
            "Asked: the owner sees the {} with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it.",
            if change { "change" } else { kind }
        ))
    }

    /// The project a chat's ask names, refused when this server doesn't serve it, as the channel's `on` refuses it.
    fn reached(&self, project: Option<Value>) -> std::result::Result<Option<Value>, super::No> {
        if let Some(named) = project.as_ref().and_then(Value::as_str) {
            if !self.projects.is_empty() && !self.projects.iter().any(|p| p == named) {
                return Err(super::No(format!("This chat reaches {}, not {named}", self.projects.join(", "))));
            }
        }
        Ok(project)
    }

    /// The chat's `create_release`, or `update_release` by `version` (`change`): `fields` as its `request` sends them,
    /// the release's fields beside `project` and `why`. Asked in its chat (`/api/chats/:chat/release-requests`), on the
    /// project it names, which saves nothing until the owner allows it. Making one names its version among its fields;
    /// changing one names the release by it, and the version itself can't change.
    pub(super) async fn ask_release_in_chat(&self, change: bool, fields: &Value) -> Said {
        let tool = if change { "update_release" } else { "create_release" };
        let chat = self.chat(tool)?;
        let mut release = fields.as_object().cloned().unwrap_or_default();
        let why = release.shift_remove("why").filter(truthy);
        let project = self.reached(release.shift_remove("project").filter(truthy))?;
        let mut body = json!({});
        if change {
            body["version"] = release.shift_remove("version").unwrap_or(Value::Null);
        }
        body["release"] = Value::Object(release);
        if let Some(project) = project {
            body["project"] = project;
        }
        if let Some(why) = why {
            body["why"] = why;
        }
        self.call(Method::POST, &format!("/api/chats/{}/release-requests", super::enc(&chat)), Some(body)).await?;
        Ok(format!(
            "Asked: the owner sees the {} with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it.",
            if change { "change" } else { "release" }
        ))
    }

    /// The chat's `reply`: its answer, in the chat `Orrery-Launch` names (ORR-1101), which the local app hears.
    pub(super) async fn reply(&self, args: &Value) -> Said {
        let chat = self.chat("reply")?;
        let body = json!({"text": args.get("text").cloned().unwrap_or(Value::Null)});
        self.call(Method::POST, &format!("/api/chats/{}/replies", super::enc(&chat)), Some(body)).await?;
        Ok("Sent.".into())
    }

    /// The chat's `request` to `offer_issue`: an issue the owner didn't ask for, offered in its chat (`/api/chats/:chat/issue-requests`)
    /// on the project it names, which files nothing until they press File issue.
    pub(super) async fn offer_issue(&self, args: &Value) -> Said {
        let chat = self.chat("offer_issue")?;
        let mut issue = args.as_object().cloned().unwrap_or_default();
        let why = issue.shift_remove("why").filter(truthy);
        let project = self.reached(issue.shift_remove("project").filter(truthy))?;
        let mut body = json!({"issue": issue});
        if let Some(project) = project {
            body["project"] = project;
        }
        if let Some(why) = why {
            body["why"] = why;
        }
        self.call(Method::POST, &format!("/api/chats/{}/issue-requests", super::enc(&chat)), Some(body)).await?;
        Ok("Offered: the owner sees it as not filed, with File issue and Don't file, and you'll hear which they pressed. Nothing is filed until they press it."
            .into())
    }

    /// The chat's `move_issues` (ORR-1100): moved at once when the owner's last message names each or was sent from its
    /// page, else asked in its chat (`/api/chats/:chat/move-requests`), on the project it names or the first issue's.
    pub(super) async fn move_issues(&self, args: &Value) -> Said {
        let chat = self.chat("move_issues")?;
        let ids = args.get("ids").cloned().unwrap_or(Value::Null);
        let mut asked = json!({"ids": ids});
        for key in ["status", "assignee"] {
            if let Some(value) = args.get(key) {
                asked[key] = value.clone();
            }
        }
        let mut body = json!({"move": asked});
        let named = self.reached(args.get("project").filter(|p| truthy(p)).cloned())?;
        let first = ids.as_array().and_then(|ids| ids.first()).and_then(Value::as_str);
        let project = match (named, first) {
            (Some(project), _) => Some(project),
            // The first issue's project, by its key, when this chat reaches more than one: else the chat's own.
            (None, Some(id)) if self.projects.len() > 1 => self.project_of_issue(&json!({"id": id})).await.ok().map(Value::String),
            _ => None,
        };
        if let Some(project) = project {
            body["project"] = project;
        }
        if let Some(why) = args.get("why").filter(|w| truthy(w)) {
            body["why"] = why.clone();
        }
        let said = self.call(Method::POST, &format!("/api/chats/{}/move-requests", super::enc(&chat)), Some(body)).await?;
        let Some(changes) = said["move"]["changes"].as_array() else { return Ok(format!("Done, as the owner asked: {}", text(&said["text"]))) };
        let n = ids.as_array().map_or(0, Vec::len);
        Ok(format!(
            "Asked, as the owner didn't name {} in their last message: the owner sees {} with Allow and Deny, and you'll hear which they pressed. Nothing moves until they allow it.",
            if n == 1 { "it" } else { "them all" },
            if changes.len() == 1 { "the change".to_string() } else { format!("the {} changes", changes.len()) }
        ))
    }

    /// The chat's `update_settings`: asked in its chat, which saves nothing until the owner allows it.
    pub(super) async fn update_settings(&self, args: &Value) -> Said {
        let chat = self.chat("update_settings")?;
        let mut body = json!({"setting": args.get("setting").cloned().unwrap_or(Value::Null)});
        if let Some(value) = args.get("value") {
            body["value"] = value.clone();
        }
        if let Some(why) = args.get("why").filter(|w| truthy(w)) {
            body["why"] = why.clone();
        }
        self.call(Method::POST, &format!("/api/chats/{}/setting-requests", super::enc(&chat)), Some(body)).await?;
        Ok("Asked: the owner sees it with Allow and Deny, and you'll hear which they pressed. Nothing is saved until they allow it.".into())
    }

    pub(super) async fn schedules(&self, args: &Value) -> Said {
        let schedules = self.call(Method::GET, &format!("{}/schedules", self.at(&self.project_of(args)?)), None).await?;
        let lines: Vec<String> = schedules.as_array().into_iter().flatten().map(line).collect();
        Ok(if lines.is_empty() { "No schedules yet.".into() } else { lines.join("\n") })
    }
}

#[cfg(test)]
#[path = "schedules_tests.rs"]
mod tests;
