// A working session asking the owner, on the issue it's working, to make a schedule or change one (ORR-458, ORR-1100):
// `askScheduleOn` and `scheduleRequest` in web/server/utils/schedule-requests.ts, and `askForSchedule` in
// web/server/store/comments.ts. The request is checked as Schedules would check it for the owner, and nothing is saved
// until they press Allow, which stays the Nuxt server's for now (`answerScheduleRequest`). The chat's own requests
// (`askSchedule` in utils/chats.ts) stay there too, as the live chat is that server's.
use crate::board::comments::Handoff;
use crate::board::issue_writes::IssueWrites;
use crate::changes::Outbox;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::work::presets::Presets;
use crate::work::schedules::Schedules;
use crate::write::{Actor, Effects};
use serde_json::{json, Map, Value};
use sqlx::AnyConnection;
use std::collections::HashMap;

/// What of a schedule a session may ask to set, by what New schedule calls it (`CHAT_SCHEDULE_FIELDS`). Whether one is
/// untrusted stays the owner's to set on Schedules.
pub(crate) const FIELDS: [(&str, &str); 20] = [
    ("kind", "Kind"),
    ("title", "Title"),
    ("notes", "Notes"),
    ("cron", "Cron"),
    ("at", "Once at"),
    ("on", "On the event"),
    ("on_filter", "Event filter"),
    ("timezone", "Timezone"),
    ("presets", "Presets"),
    ("column", "Issues start in, or an action moves them to"),
    ("move_from", "An action moves them from"),
    ("milestone", "Milestone"),
    ("priority", "Priority"),
    ("labels", "Labels"),
    ("ask", "Ask sessions"),
    ("skip_open", "Skip while open"),
    ("only_if_changed", "Only if changed"),
    ("model", "Model"),
    ("effort", "Effort"),
    ("enabled", "Running"),
];

fn label(field: &str) -> &'static str {
    FIELDS.iter().find(|(f, _)| *f == field).map(|(_, l)| *l).unwrap_or("")
}

/// A value as JavaScript's `String` writes it.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Array(items) => items.iter().map(|v| if v.is_null() { String::new() } else { js_string(v) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

/// A value of a schedule as a request shows it (`scheduleValue`).
fn shown_value(value: &Value) -> String {
    match value {
        Value::Array(items) if items.is_empty() => "(none)".into(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(", "),
        Value::Object(map) if map.is_empty() => "(none)".into(),
        Value::Object(map) => map.iter().map(|(k, v)| format!("{k}: {}", js_string(v))).collect::<Vec<_>>().join(", "),
        Value::Null => "(none)".into(),
        Value::String(s) if s.is_empty() => "(none)".into(),
        Value::Bool(true) => "on".into(),
        Value::Bool(false) => "off".into(),
        other => js_string(other),
    }
}

/// What a request asks, as a line: "make the schedule X", "change schedule 3 (X): …" (`scheduleAsk`).
pub(crate) fn ask_line(request: &Value) -> String {
    let title = js_string(&request["title"]);
    match request.get("id").and_then(Value::as_i64) {
        None => format!("make the schedule \"{title}\""),
        Some(id) => {
            let changes = request["changes"].as_array().map(Vec::as_slice).unwrap_or_default();
            let said = changes.iter().map(|c| format!("{} to {}", label(c["field"].as_str().unwrap_or_default()), shown_value(&c["to"]))).collect::<Vec<_>>();
            format!("change schedule {id} (\"{title}\"): {}", said.join(", "))
        }
    }
}

pub(crate) struct ScheduleRequests<'c> {
    conn: &'c mut AnyConnection,
}

/// What an ask left: the comment asking (with its request), its hand-on to the sessions and the bell, what the write
/// set off, and the line for the event log.
pub(crate) struct Asked {
    pub comment: Value,
    pub handoff: Handoff,
    pub effects: Effects,
    pub line: String,
    pub request: Value,
}

impl<'c> ScheduleRequests<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        ScheduleRequests { conn }
    }

    /// The names of the presets `ids`, those that are still there.
    async fn preset_names(&mut self, project: &str, ids: &[Value]) -> Result<HashMap<i64, String>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let all = Presets::new(self.conn).list(Some(project)).await?;
        Ok(all
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| Some((p["id"].as_i64()?, p["name"].as_str()?.to_string())))
            .filter(|(id, _)| ids.iter().any(|i| i.as_i64() == Some(*id)))
            .collect())
    }

    /// A request to make a schedule in `project`, or change schedule `target` there (`scheduleRequest`): `fields` as
    /// Schedules takes them, checked as Schedules would check them for the owner, each shown from → to. Saves nothing.
    pub(crate) async fn request(&mut self, project: &str, fields: Option<&Value>, target: Option<&Value>) -> Result<Value> {
        let names = FIELDS.iter().map(|(f, _)| *f).collect::<Vec<_>>();
        let Some(fields) = fields.and_then(Value::as_object).filter(|f| !f.is_empty()) else {
            return Err(ApiError::bad_request(format!(
                "Send {{schedule: {{…}}, id?}}: the fields to set, any of {}, and the schedule's id to change one",
                names.join(", ")
            )));
        };
        let refused = fields.keys().filter(|k| !names.contains(&k.as_str())).cloned().collect::<Vec<_>>();
        if !refused.is_empty() {
            return Err(ApiError::forbidden(format!(
                "A session sets a schedule's {}, not its {}: the rest are the owner's to set on Schedules",
                names.join(", "),
                refused.join(", ")
            )));
        }
        let target = match target {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_i64()
                    .filter(|_| value.is_i64() || value.is_u64())
                    .ok_or_else(|| ApiError::bad_request("Send \"id\" as the number of the schedule to change, or leave it out to make one"))?,
            ),
        };
        let uid = Presets::new(self.conn).uid().await?;
        let current = match target {
            Some(id) => Some(Schedules::new(self.conn).get(project, &id.to_string(), &uid).await?),
            None => None,
        };
        let owner = Actor { name: IssueWrites::new(self.conn).owner_id().await?, owner: true, ..Actor::default() };
        let body = Value::Object(fields.clone());
        Schedules::new(self.conn).check(project, target, &body, &uid, &owner).await?;
        let mut ids: Vec<Value> = fields.get("presets").and_then(Value::as_array).cloned().unwrap_or_default();
        ids.extend(current.as_ref().and_then(|c| c["presets"].as_array().cloned()).unwrap_or_default());
        let presets = self.preset_names(project, &ids).await?;
        let shown = |field: &str, value: &Value| match (field, value) {
            ("presets", Value::Array(items)) => {
                Value::Array(items.iter().map(|p| p.as_i64().and_then(|id| presets.get(&id)).map(|n| json!(n)).unwrap_or_else(|| p.clone())).collect())
            }
            _ => value.clone(),
        };
        let changes = fields
            .iter()
            .map(|(field, to)| match &current {
                Some(current) => {
                    json!({"field": field, "from": shown(field, current.get(field.as_str()).unwrap_or(&Value::Null)), "to": shown(field, to)})
                }
                None => json!({"field": field, "to": shown(field, to)}),
            })
            .collect::<Vec<_>>();
        let title = fields.get("title").filter(|t| !t.is_null()).or_else(|| current.as_ref().map(|c| &c["title"]).filter(|t| !t.is_null()));
        let mut request = Map::new();
        if let Some(id) = target {
            request.insert("id".into(), json!(id));
        }
        request.insert("title".into(), json!(title.map(js_string).unwrap_or_default()));
        request.insert("changes".into(), Value::Array(changes));
        request.insert("body".into(), body);
        request.insert("state".into(), json!("asked"));
        Ok(Value::Object(request))
    }

    /// A working session asking the owner, on `issue`, to make or change a schedule (`askScheduleOn`): `body` is
    /// `{schedule, id?, why?}`. A comment waiting on the owner's decision, with the request kept beside it; one asked
    /// before for the same schedule, still unanswered, expires (a change by the schedule's id anywhere in the project, a
    /// new one by its title on this issue).
    pub(crate) async fn ask(&mut self, project: &str, sent: &str, body: &Value, actor: &Actor) -> Result<Asked> {
        if actor.owner {
            return Err(ApiError::bad_request("The owner makes and changes schedules on Schedules: this is for a session to ask them"));
        }
        let request = self.request(project, body.get("schedule"), body.get("id")).await?;
        let line = ask_line(&request);
        let why = body.get("why").and_then(Value::as_str).map(str::trim).unwrap_or_default();
        let words = [why.to_string(), format!("Asks to {line}. Nothing is saved until you press Allow.")]
            .into_iter()
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        let issue = IssueWrites::new(self.conn).issue_id(project, sent).await?;
        let schedule = request.get("id").and_then(Value::as_i64);
        let title = request["title"].as_str().unwrap_or_default().to_string();
        match schedule {
            None => {
                sqlx::query(&sql("UPDATE schedule_requests SET state = 'expired' WHERE state = 'asked' AND schedule IS NULL AND title = ? \
                    AND comment IN (SELECT id FROM comments WHERE project = ? AND issue = ?)"))
                .bind(&title)
                .bind(project)
                .bind(&issue)
                .execute(&mut *self.conn)
                .await?;
            }
            Some(id) => {
                sqlx::query(&sql("UPDATE schedule_requests SET state = 'expired' WHERE state = 'asked' AND schedule = ? \
                    AND comment IN (SELECT id FROM comments WHERE project = ?)"))
                .bind(id)
                .bind(project)
                .execute(&mut *self.conn)
                .await?;
            }
        }
        let mut writes = IssueWrites::new(self.conn);
        writes.outbox = Some(Outbox::new(actor.clone()));
        let (comment, handoff) = writes.create(project, &issue, &json!({"body": words, "asks": "decision"}), actor).await?;
        let effects = std::mem::take(&mut writes.effects);
        let id = comment["id"].as_i64().unwrap_or_default();
        sqlx::query(&sql("INSERT INTO schedule_requests (comment, schedule, title, changes, body, state) VALUES (?, ?, ?, ?, ?, ?)"))
            .bind(id)
            .bind(schedule)
            .bind(&title)
            .bind(request["changes"].to_string())
            .bind(request["body"].to_string())
            .bind("asked")
            .execute(&mut *self.conn)
            .await?;
        let comment = IssueWrites::new(self.conn).comment(project, &issue, id).await?;
        Ok(Asked { comment, handoff, effects, line, request })
    }
}

#[cfg(test)]
#[path = "schedule_requests_tests.rs"]
mod tests;
