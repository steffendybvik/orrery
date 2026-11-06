// The orrery's own settings (ORR-954): what `settings` and `updateSettings` in web/server/store/statuses.ts do, on the
// same `settings` table, answering as `GET` and `PATCH /api/settings` did. Every setting is here, the Mac's own
// (`terminal`, `starts`, `advanced`) too: the owner's "everything that needs to be persisted should be in the api"
// (the `decision-rust-api-secrets-settings` doc). What only the running server knows, `environment` and `database`,
// is Nuxt's `GET /api/machine`. A change tells the settings stream (`Effects.settings`), every project when `starts`
// changed (each says whether orrery starts its sessions), and the keys changed (`Effects.settings_keys`), which the
// router notes in the event log as the Nuxt route did.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::docs::{js, Actor, Effects};
use crate::error::{ApiError, Result};
use crate::statuses::{Statuses, TINT, TINTS};
use crate::text::is_slug;
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::{AnyConnection, Row};
use std::sync::LazyLock;

/// `SETTINGS_FIELDS` in web/server/store/schema.ts, in its order, which is the order its problems are found in.
const FIELDS: [&str; 15] = [
    "tint",
    "focus_prompt",
    "milestone_prompt",
    "instructions",
    "tracker",
    "handle",
    "starts",
    "terminal",
    "restrict_proposals",
    "advanced",
    "pick_next",
    "work_kinds",
    "count_use",
    "starred",
    "hidden",
];
/// `TERMINALS` in web/shared/roadmap/settings.ts.
const TERMINALS: [&str; 4] = ["terminal", "iterm", "warp", "ghostty"];
/// `EFFORTS` and `MODEL_ALIASES` in web/shared/roadmap/sessions.ts.
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const MODEL_ALIASES: [&str; 7] = ["best", "opus", "sonnet", "haiku", "fable", "default", "opusplan"];
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^claude-[a-z0-9.-]+(\[1m\])?$").unwrap());
static TRACKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://\S*\{id\}\S*$").unwrap());
static HANDLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$").unwrap());

/// `WORK_KINDS` in web/shared/roadmap/work-kinds.ts: the kinds orrery ships, highest-ranked first.
fn work_kinds() -> Value {
    json!([
        {"id": "security", "name": "Security", "labels": ["security"], "model": "best"},
        {"id": "release", "name": "Release", "labels": ["release"], "model": "best"},
        {"id": "bug", "name": "Bug", "labels": ["bug"], "model": "best"},
        {"id": "feature", "name": "Feature", "labels": ["feature", "feature request", "improvement"], "model": "best"},
        {"id": "research", "name": "Research", "labels": ["research"], "model": "best"},
        {"id": "maintenance", "name": "Maintenance", "labels": ["maintenance", "cleanup", "test", "tests", "ci", "perf"], "model": "best"},
        {"id": "docs", "name": "Docs", "labels": ["docs", "documentation"], "model": "sonnet"},
        {"id": "roadmap", "name": "Roadmap", "labels": [], "model": "sonnet"},
        {"id": "other", "name": "Other", "labels": [], "model": "best"},
        {"id": "chat", "name": "Chat", "labels": [], "model": "sonnet"},
    ])
}

pub(crate) fn hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    getrandom::getrandom(&mut bytes).expect("the system's random numbers");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The 403 for a session changing them, as `ownerOnly(actor, 'settings.write')` words it.
fn owner_only(actor: &Actor) -> Result<()> {
    if actor.owner {
        return Ok(());
    }
    Err(ApiError::refused_for(
        "settings.write",
        "Change App settings and the statuses: owner only for a session (settings.write). They change how orrery runs for every project and session. Send Orrery-Actor: <owner>",
    ))
}

/// A whole number from 1 to `most`, as `Number.isInteger(n) && n >= 1 && n <= most`.
fn whole(n: Option<&Value>, most: f64) -> bool {
    n.and_then(Value::as_f64).is_some_and(|n| n.fract() == 0.0 && (1.0..=most).contains(&n))
}

/// `parseStarts`: `{limit, min?, minutes?, idle_minutes?, on_signal?}`, as the value to keep.
fn parse_starts(value: &Value) -> std::result::Result<Value, String> {
    let empty = Map::new();
    let sent = value.as_object().unwrap_or(&empty);
    let at = |key: &str| sent.get(key);
    let maybe = |key: &str, most: f64| matches!(at(key), None | Some(Value::Null)) || whole(at(key), most);
    let limit = at("limit").and_then(Value::as_f64).unwrap_or(f64::NAN);
    let rest = sent.keys().any(|k| !["limit", "min", "minutes", "idle_minutes", "on_signal"].contains(&k.as_str()));
    if rest
        || !whole(at("limit"), 20.0)
        || !maybe("min", limit)
        || !maybe("minutes", 1440.0)
        || !maybe("idle_minutes", 1440.0)
        || !matches!(at("on_signal"), None | Some(Value::Null) | Some(Value::Bool(_)))
    {
        return Err(format!("should be {{limit, min?, minutes?, idle_minutes?, on_signal?}}: at most 20 sessions at once, at least 1 to that many kept running or none, each for 1 to 1440 minutes or until stopped, stopped after 1 to 1440 idle minutes or never, and whether work finding nobody listening starts one (true or false), not {}", js(value)));
    }
    let mut kept = Map::new();
    kept.insert("limit".into(), at("limit").cloned().unwrap_or(Value::Null));
    for key in ["min", "minutes", "idle_minutes"] {
        if let Some(n) = at(key).filter(|n| n.as_f64().is_some_and(|n| n != 0.0)) {
            kept.insert(key.into(), n.clone());
        }
    }
    if at("on_signal") == Some(&Value::Bool(false)) {
        kept.insert("on_signal".into(), Value::Bool(false));
    }
    Ok(Value::Object(kept))
}

/// `parseWorkKinds`: each `{id, name, labels, model, effort?}`, ids unique and a label in one kind only.
fn parse_work_kinds(value: &Value) -> std::result::Result<Value, String> {
    let fail = |why: String| format!("should be a list of {{id, name, labels, model, effort?}}, highest-ranked first: {why}");
    let Some(list) = value.as_array().filter(|l| !l.is_empty()) else { return Err(fail("at least one kind".into())) };
    let mut ids: Vec<String> = vec![];
    let mut labels: Vec<(String, String)> = vec![];
    let mut kinds = vec![];
    let empty = Map::new();
    for kind in list {
        let kind = kind.as_object().unwrap_or(&empty);
        let rest: Vec<&str> = kind.keys().map(String::as_str).filter(|k| !["id", "name", "labels", "model", "effort"].contains(k)).collect();
        if !rest.is_empty() {
            return Err(fail(format!("{} isn't a kind's", rest.join(", "))));
        }
        let id = match kind.get("id").and_then(Value::as_str).filter(|id| is_slug(id)) {
            Some(id) => id.to_string(),
            None => {
                return Err(fail(format!(
                    "each needs an id of lowercase letters, digits and dashes, not {}",
                    kind.get("id").map(js).unwrap_or_else(|| "undefined".into())
                )))
            }
        };
        if ids.contains(&id) {
            return Err(fail(format!("\"{id}\" is there twice")));
        }
        ids.push(id.clone());
        let Some(name) = kind.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()) else { return Err(fail(format!("{id} needs a name"))) };
        let Some(own) = kind.get("labels").and_then(Value::as_array).filter(|l| l.iter().all(|l| l.as_str().is_some_and(|l| !l.trim().is_empty()))) else {
            return Err(fail(format!("{id}'s labels should be a list of labels")));
        };
        let mut lower: Vec<String> = vec![];
        for label in own.iter().filter_map(Value::as_str).map(|l| l.trim().to_lowercase()) {
            if !lower.contains(&label) {
                lower.push(label);
            }
        }
        for label in &lower {
            if let Some((_, other)) = labels.iter().find(|(l, _)| l == label) {
                return Err(fail(format!("label \"{label}\" is in both {other} and {id}")));
            }
            labels.push((label.clone(), id.clone()));
        }
        let model = kind.get("model");
        let is_model = model.and_then(Value::as_str).is_some_and(|m| m.chars().count() <= 64 && (MODEL_ALIASES.contains(&m) || MODEL.is_match(m)));
        if !is_model {
            return Err(fail(format!(
                "{id}'s model should be best, opus, sonnet, haiku, fable, default, opusplan or a full id, not {}",
                model.map(js).unwrap_or_else(|| "undefined".into())
            )));
        }
        let effort = kind.get("effort").filter(|e| !e.is_null());
        if effort.is_some_and(|e| !e.as_str().is_some_and(|e| EFFORTS.contains(&e))) {
            return Err(fail(format!("{id}'s effort should be one of {}", EFFORTS.join(", "))));
        }
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        out.insert("name".into(), json!(name.trim()));
        out.insert("labels".into(), json!(lower));
        out.insert("model".into(), model.cloned().unwrap_or(Value::Null));
        if let Some(effort) = effort.filter(|e| e.as_str().is_some_and(|e| !e.is_empty())) {
            out.insert("effort".into(), effort.clone());
        }
        kinds.push(Value::Object(out));
    }
    Ok(Value::Array(kinds))
}

/// A body as `checkInput(body, SETTINGS_FIELDS, true)` takes it, each value as the store keeps it.
fn check_input(body: &Value) -> Result<Map<String, Value>> {
    let Some(sent) = body.as_object() else {
        return Err(ApiError::bad_request("The body should be a JSON object"));
    };
    let fields = &FIELDS;
    let mut problems = vec![];
    for key in sent.keys() {
        if !fields.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", fields.join(", ")));
        }
    }
    let mut input = Map::new();
    for &key in fields {
        let Some(value) = sent.get(key) else { continue };
        if value.is_null() {
            // Every setting but the booleans can be null.
            if ["restrict_proposals", "advanced", "pick_next", "count_use"].contains(&key) {
                problems.push(format!("\"{key}\" can't be null"));
            } else {
                input.insert(key.into(), Value::Null);
            }
            continue;
        }
        match key {
            "starts" | "work_kinds" => match if key == "starts" { parse_starts(value) } else { parse_work_kinds(value) } {
                Ok(kept) => {
                    input.insert(key.into(), kept);
                }
                Err(why) => problems.push(format!("\"{key}\": {why}")),
            },
            "instructions" => {
                let lines: Option<Vec<Value>> = value.as_array().and_then(|lines| {
                    lines
                        .iter()
                        .map(|line| {
                            let text = line.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty())?;
                            let id = line.get("id");
                            let on = line.get("on");
                            if id.is_some_and(|id| !id.is_string()) || on.is_some_and(|on| !on.is_boolean()) {
                                return None;
                            }
                            let id = id.and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string).unwrap_or_else(|| hex(4));
                            Some(json!({"id": id, "text": text.trim(), "on": on.and_then(Value::as_bool).unwrap_or(true)}))
                        })
                        .collect()
                });
                match lines {
                    Some(lines) => {
                        input.insert(key.into(), Value::Array(lines));
                    }
                    None => problems.push(format!("\"{key}\" should be a list of {{text, on?, id?}}, not {}", js(value))),
                }
            }
            "starred" | "hidden" => match value.as_array().filter(|l| l.iter().all(|v| v.as_str().is_some_and(|v| !v.trim().is_empty()))) {
                Some(list) => {
                    let mut ids: Vec<String> = vec![];
                    for id in list.iter().filter_map(Value::as_str).map(|v| v.trim().to_string()) {
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                    input.insert(key.into(), json!(ids));
                }
                None => problems.push(format!("\"{key}\" should be a list of strings, not {}", js(value))),
            },
            "restrict_proposals" | "advanced" | "pick_next" | "count_use" => match value {
                Value::Bool(_) => {
                    input.insert(key.into(), value.clone());
                }
                _ => problems.push(format!("\"{key}\" should be a boolean, not {}", js(value))),
            },
            _ => {
                let Some(text) = value.as_str() else {
                    problems.push(format!("\"{key}\" should be a string, not {}", js(value)));
                    continue;
                };
                let problem = match key {
                    "terminal" if !TERMINALS.contains(&text) => Some(format!("\"{key}\" is \"{text}\", not one of {} (or null)", TERMINALS.join(", "))),
                    "tint" if !TINT.is_match(text) => Some(format!("\"{key}\" is \"{text}\"; use {} or a colour like #3b82f6", TINTS.join(", "))),
                    "tracker" if !TRACKER.is_match(text) => Some(format!(
                        "\"{key}\" is \"{text}\"; use the web address of a task with {{id}} where its id goes, e.g. https://tracker.example.com/issue/{{id}}"
                    )),
                    "handle" if !HANDLE.is_match(text) => {
                        Some(format!("\"{key}\" is \"{text}\"; use letters, digits, dots, dashes and underscores, e.g. your GitHub login"))
                    }
                    _ => None,
                };
                match problem {
                    Some(problem) => problems.push(problem),
                    None => {
                        let kept = match key {
                            // An empty template is none: the default.
                            "focus_prompt" | "milestone_prompt" => Some(text.trim()).filter(|t| !t.is_empty()).map(|t| json!(t)).unwrap_or(Value::Null),
                            "handle" => json!(text.to_lowercase()),
                            _ => value.clone(),
                        };
                        input.insert(key.into(), kept);
                    }
                }
            }
        }
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(input)
}

pub struct Settings<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> Settings<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Settings { conn, effects: Effects::default(), outbox: None }
    }

    async fn rows(&mut self) -> Result<Vec<(String, Value)>> {
        let rows = sqlx::query("SELECT key, value FROM settings").fetch_all(&mut *self.conn).await?;
        Ok(rows.iter().map(|r| (r.get::<String, _>("key"), serde_json::from_str(&r.get::<String, _>("value")).unwrap_or(Value::Null))).collect())
    }

    /// This orrery's own settings, as `settings()` gives them: its id is made the first time it's asked for, and kept.
    pub async fn get(&mut self) -> Result<Value> {
        let mut rows = self.rows().await?;
        if !rows.iter().any(|(k, _)| k == "id") {
            sqlx::query(&sql("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING"))
                .bind("id")
                .bind(js(&json!(format!("orr_{}", hex(3)))))
                .execute(&mut *self.conn)
                .await?;
            rows = self.rows().await?;
        }
        let value = |key: &str| rows.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        // `?? fallback`: a missing or null value is the fallback; `|| null`: any falsy one is null.
        let or = |key: &str, fallback: Value| value(key).filter(|v| !v.is_null()).unwrap_or(fallback);
        let truthy = |key: &str| value(key).filter(|v| !matches!(v, Value::Null | Value::Bool(false)) && v.as_str() != Some("")).unwrap_or(Value::Null);
        let ids = |key: &str| -> Vec<String> { value(key).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default() };
        let hidden = ids("hidden");
        let starred: Vec<String> = ids("starred").into_iter().filter(|id| !hidden.contains(id)).collect();
        let statuses = Statuses::new(&mut *self.conn).list().await?;
        Ok(json!({
            "id": value("id").unwrap_or(Value::Null),
            "tint": or("tint", Value::Null),
            "statuses": statuses,
            "focus_prompt": truthy("focus_prompt"),
            "milestone_prompt": truthy("milestone_prompt"),
            "instructions": or("instructions", json!([])),
            "handle": truthy("handle"),
            "uid": or("uid", json!("")),
            "tracker": truthy("tracker"),
            "starts": or("starts", Value::Null),
            "terminal": or("terminal", json!("terminal")),
            "restrict_proposals": or("restrict_proposals", json!(true)),
            "advanced": or("advanced", json!(true)),
            "pick_next": or("pick_next", json!(false)),
            "count_use": or("count_use", json!(false)),
            "work_kinds": or("work_kinds", work_kinds()),
            "starred": starred,
            "hidden": hidden,
        }))
    }

    /// The owner's to change: they're how the orrery looks to them.
    pub async fn update(&mut self, body: &Value, actor: &Actor) -> Result<Value> {
        owner_only(actor)?;
        let input = check_input(body)?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            for (key, value) in &input {
                sqlx::query(&sql("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"))
                    .bind(key)
                    .bind(js(value))
                    .execute(&mut *self.conn)
                    .await?;
            }
            self.effects.settings = true;
            if input.contains_key("starts") {
                let rows = sqlx::query("SELECT id FROM projects").fetch_all(&mut *self.conn).await?;
                self.effects.changed = rows.iter().map(|r| r.get::<String, _>("id")).collect();
            }
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        // The keys sent, as the route noted them: those given, even as null, sorted.
        let mut keys: Vec<String> = body.as_object().map(|b| b.keys().cloned().collect()).unwrap_or_default();
        keys.sort();
        self.effects.settings_keys = keys;
        self.get().await
    }
}
