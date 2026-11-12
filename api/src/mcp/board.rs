// The board's tools at `/mcp` (ORR-1099), each as channel/tools.mjs runs it: a call to one of this API's own routes,
// as the channel calls the REST API, and its answer in the channel's words. A route is run through `routes::all()` with
// its rails (access/rails.rs), as whoever called `/mcp` (their `Orrery-*` headers, which the guard already checked), so
// a tool can do only what that route lets them. So far: docs, presets, milestones, schedules (board/schedules.rs),
// releases, epics, issues (listed, read (board/issue.rs), made, changed, commented on), and the event log, secrets and the chat's images
// (board/machine.rs).
use crate::{access, routes, App};
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware;
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

mod issue;
mod machine;
mod schedules;

/// What a tool says when orrery refuses it, or the tool can't run: `orrery said no: …`, as the channel words it.
pub(crate) struct No(pub(crate) String);

impl From<crate::error::ApiError> for No {
    fn from(error: crate::error::ApiError) -> Self {
        No(error.message)
    }
}

type Said = std::result::Result<String, No>;

/// This API's routes, called as the `/mcp` request's caller.
pub(crate) struct Api<'a> {
    pub(crate) app: &'a Arc<App>,
    pub(crate) headers: &'a HeaderMap,
    pub(crate) projects: &'a [String],
}

fn enc(part: &str) -> String {
    // As encodeURIComponent: all but A–Z a–z 0–9 - _ . ! ~ * ' ( ).
    const KEEP: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(part, KEEP).to_string()
}

fn str_of<'v>(args: &'v Value, key: &str) -> Option<&'v str> {
    args.get(key).and_then(Value::as_str)
}

impl Api<'_> {
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> std::result::Result<Value, No> {
        let (status, _, bytes) = self.send(method, path, body).await?;
        let data: Value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
        if !status.is_success() {
            let message = data["message"].as_str().or(data["statusMessage"].as_str()).map(String::from);
            return Err(No(message.unwrap_or_else(|| format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or("")))));
        }
        Ok(data)
    }

    /// A route's reply as it came: its status, headers and body, for one that isn't JSON (`image`).
    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> std::result::Result<(StatusCode, HeaderMap, Bytes), No> {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in self.headers {
            if name != header::CONTENT_LENGTH && name != header::CONTENT_TYPE && name != header::ACCEPT {
                request = request.header(name, value);
            }
        }
        let request = match body {
            Some(body) => request.header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .map_err(|e| No(e.to_string()))?;
        let router = routes::all().route_layer(middleware::from_fn_with_state(self.app.clone(), access::rails::rails)).with_state(self.app.clone());
        let response = router.oneshot(request).await.map_err(|e| No(e.to_string()))?;
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.map_err(|e| No(e.to_string()))?;
        Ok((parts.status, parts.headers, bytes))
    }

    /// The project a call is on, as the channel's `projectOf` has it for a tool that names no issue: the only one, or
    /// the one it names.
    fn project_of(&self, args: &Value) -> std::result::Result<String, No> {
        if self.projects.len() == 1 {
            return Ok(self.projects[0].clone());
        }
        let listed = self.projects.join(", ");
        match str_of(args, "project").filter(|p| !p.is_empty()) {
            None => Err(No(format!("Say which project: {listed}"))),
            Some(p) if !self.projects.iter().any(|x| x == p) => Err(No(format!("This server serves {listed}, not {p}"))),
            Some(p) => Ok(p.to_string()),
        }
    }

    /// The project a call is on when it may name an issue (`id` or `issue`), as `projectOf` has it: the only one;
    /// else the issue's, by its id's key; else the one it names.
    async fn project_of_issue(&self, args: &Value) -> std::result::Result<String, No> {
        if self.projects.len() == 1 {
            return Ok(self.projects[0].clone());
        }
        let named = str_of(args, "project").filter(|p| !p.is_empty());
        let reference = str_of(args, "id").or_else(|| str_of(args, "issue"));
        if let (None, Some(reference)) = (named, reference) {
            let shaped = reference.split_once('-').is_some_and(|(key, n)| {
                key.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                    && key.chars().all(|c| c.is_ascii_alphanumeric())
                    && !n.is_empty()
                    && n.chars().all(|c| c.is_ascii_digit())
            });
            if shaped {
                let key = reference.split('-').next().unwrap_or_default().to_uppercase();
                let found = self
                    .list("/api/projects")
                    .await?
                    .into_iter()
                    .find(|p| p["key"].as_str() == Some(key.as_str()) && self.projects.iter().any(|x| p["id"].as_str() == Some(x)));
                return match found {
                    Some(project) => Ok(text(&project["id"])),
                    None => Err(No(format!("{reference} isn't an issue of {}: its key is none of theirs", self.projects.join(", ")))),
                };
            }
        }
        self.project_of(args)
    }

    fn issue_path(&self, project: &str, id: &str) -> String {
        format!("{}/issues/{}", self.at(project), enc(id))
    }

    async fn issues(&self, args: &Value) -> Said {
        // Made before the first await: the serializer isn't Send.
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            for key in ["status", "assignee", "milestone", "release", "label", "external", "blocked", "q"] {
                if let Some(value) = args.get(key) {
                    query.append_pair(key, &text(value));
                }
            }
            if args.get("q").is_some_and(truthy) {
                query.append_pair("in", "all");
            }
            query.finish()
        };
        let mut issues = self.list(&format!("{}/issues?{query}", self.at(&self.project_of(args)?))).await?;
        let filtered = args.get("status").is_some_and(truthy);
        if args["open"] != false && !filtered {
            issues.retain(|i| i["kind"] != "done" && i["kind"] != "canceled");
        }
        let actor = crate::request::actor_of(self.headers);
        // A work session lists only what it could take up: backlog is mostly proposals and research (ORR-545).
        let backlog = if actor.chat || args["open"] == false || filtered { 0 } else { issues.iter().filter(|i| i["kind"] == "backlog").count() };
        if backlog > 0 {
            issues.retain(|i| i["kind"] != "backlog");
        }
        let mut shown = 0;
        let said: Vec<String> = issues
            .iter()
            .map(|i| {
                let Some(within) = i["match_in"].as_str().filter(|m| !m.is_empty()) else { return line(i) };
                let mut said = format!("{}\n    in its {within}", line(i));
                if let Some(found) = i["match"].as_str().filter(|m| !m.is_empty() && !actor.untrusted) {
                    shown += 1;
                    if shown <= MATCHES_SHOWN {
                        said.push_str(&format!(": {found}"));
                    }
                }
                said
            })
            .collect();
        let mut parts = vec![if said.is_empty() { "No issues match.".to_string() } else { said.join("\n") }];
        if backlog > 0 {
            parts.push(format!("{backlog} in backlog not shown: status: backlog lists them"));
        }
        Ok(parts.join("\n"))
    }

    async fn create_issue(&self, args: &Value) -> Said {
        let mut fields = args.as_object().cloned().unwrap_or_default();
        let proposal = fields.remove("proposal").is_some_and(|p| truthy(&p));
        fields.remove("project");
        if proposal {
            fields.insert("proposal".into(), json!("pending"));
        }
        let project = self.project_of(&json!({"project": args.get("project")}))?;
        let issue = self.call(Method::POST, &format!("{}/issues", self.at(&project)), Some(Value::Object(fields))).await?;
        Ok(format!("Made {}", line(&issue)))
    }

    /// `update_issue` and `edit_issue`: the fields sent, on the issue `id`.
    async fn change_issue(&self, args: &Value) -> Said {
        let mut fields = args.as_object().cloned().unwrap_or_default();
        let id = fields.remove("id").map(|i| text(&i)).unwrap_or_default();
        let project = self.project_of_issue(&json!({"id": id})).await?;
        let issue = self.call(Method::PATCH, &self.issue_path(&project, &id), Some(Value::Object(fields))).await?;
        Ok(format!("Now {}", line(&issue)))
    }

    async fn comment(&self, args: &Value) -> Said {
        let id = text(&args["id"]);
        let project = self.project_of_issue(&json!({"id": id})).await?;
        let mut body = json!({"body": args.get("body").cloned().unwrap_or(Value::Null)});
        let asks = args.get("asks").filter(|a| truthy(a)).cloned();
        if let Some(asks) = &asks {
            body["asks"] = asks.clone();
        }
        let posted = self.call(Method::POST, &format!("{}/comments", self.issue_path(&project, &id)), Some(body)).await?;
        let asking = match asks.as_ref().and_then(Value::as_str) {
            Some("decision") => ", asking the owner for a decision".to_string(),
            Some(_) => ", asking the owner for feedback".to_string(),
            None => String::new(),
        };
        Ok(format!("Commented on {id} (comment {}){asking}.", text(&posted["id"])))
    }

    async fn comment_epic(&self, args: &Value) -> Said {
        let id = text(&args["id"]);
        let posted = self
            .call(Method::POST, &format!("/api/epics/{}/comments", enc(&id)), Some(json!({"body": args.get("body").cloned().unwrap_or(Value::Null)})))
            .await?;
        Ok(format!("Commented on epic {id} (comment {}).", text(&posted["id"])))
    }

    /// `rate_pull`: a PR's risk, given as `owner/name#number` or its link, as the channel reads it.
    async fn rate_pull(&self, args: &Value) -> Said {
        let pull = match args.get("pull") {
            None | Some(Value::Null) => String::new(),
            Some(value) => text(value),
        };
        let found = regex::Regex::new(r"(?:github\.com/)?([\w.-]+)/([\w.-]+)(?:#|/pull/)(\d+)")
            .expect("the PR pattern")
            .captures(&pull)
            .map(|c| (c[1].to_string(), c[2].to_string(), c[3].to_string()));
        let Some((owner, name, number)) = found else {
            let shown = match args.get("pull") {
                None => "undefined".to_string(),
                Some(value) => value.to_string(),
            };
            return Ok(format!("Give the PR as owner/name#number or its link, not {shown}"));
        };
        let id = text(&args["id"]);
        let project = self.project_of_issue(&json!({"id": id})).await?;
        let path = format!("{}/pulls/{}/{}/{number}/risk", self.issue_path(&project, &id), enc(&owner), enc(&name));
        let rated = self.call(Method::PUT, &path, Some(pick(args, &["level", "why"]))).await?;
        Ok(format!("Rated {owner}/{name}#{number} on {id}: {} risk, {}", text(&rated["risk"]["level"]), text(&rated["risk"]["why"])))
    }

    fn at(&self, project: &str) -> String {
        format!("/api/projects/{}", enc(project))
    }

    async fn docs(&self, args: &Value) -> Said {
        let q = str_of(args, "q").filter(|q| !q.is_empty());
        let query = q.map(|q| format!("?q={}", url::form_urlencoded::byte_serialize(q.as_bytes()).collect::<String>())).unwrap_or_default();
        let docs = self.call(Method::GET, &format!("{}/docs{query}", self.at(&self.project_of(args)?)), None).await?;
        let lines: Vec<String> = docs
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                let s = |k: &str| d[k].as_str().filter(|v| !v.is_empty());
                let mut line = format!("{}: {}", s("id").unwrap_or_default(), s("title").unwrap_or_default());
                if d["kind"] == "artifact" {
                    line.push_str(" (artifact)");
                }
                if let Some(section) = s("section") {
                    line.push_str(&format!(" [{section}]"));
                }
                if let Some(summary) = s("summary") {
                    line.push_str(&format!(" — {summary}"));
                }
                if let Some(m) = s("match") {
                    line.push_str(&format!("\n    {m}"));
                }
                line
            })
            .collect();
        Ok(if !lines.is_empty() {
            lines.join("\n")
        } else if q.is_some() {
            "No docs match.".into()
        } else {
            "No docs yet.".into()
        })
    }

    async fn doc(&self, args: &Value) -> Said {
        let id = str_of(args, "id").unwrap_or_default();
        let path = format!("{}/docs/{}", self.at(&self.project_of(args)?), enc(id));
        if args["history"].as_bool().unwrap_or(false) {
            let revisions = self.call(Method::GET, &format!("{path}/revisions"), None).await?;
            let lines: Vec<String> = revisions
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| {
                    let what = if r["deleted"].as_bool().unwrap_or(false) { "removed".to_string() } else { text(&r["title"]) };
                    let by = match r["session_name"].as_str().filter(|s| !s.is_empty()) {
                        Some(session) => format!("{}, {session}", text(&r["created_by"])),
                        None => text(&r["created_by"]),
                    };
                    format!("{}: {what} ({by}, {})", text(&r["id"]), text(&r["created_at"]))
                })
                .collect();
            return Ok(lines.join("\n"));
        }
        let path = match args.get("revision").filter(|r| !r.is_null()) {
            Some(revision) => format!("{path}/revisions/{}", text(revision)),
            None => path,
        };
        let doc = self.call(Method::GET, &path, None).await?;
        Ok(format!("# {}\n\n{}", text(&doc["title"]), text(&doc["body"])))
    }

    async fn write_doc(&self, args: &Value) -> Said {
        let id = str_of(args, "id").unwrap_or_default();
        let mut body = json!({"title": args.get("title").cloned().unwrap_or(Value::Null), "body": args.get("body").cloned().unwrap_or(Value::Null)});
        for key in ["section", "kind"] {
            if let Some(value) = args.get(key) {
                body[key] = value.clone();
            }
        }
        self.call(Method::PUT, &format!("{}/docs/{}", self.at(&self.project_of(args)?), enc(id)), Some(body)).await?;
        Ok(format!("Saved the doc {id}."))
    }

    async fn presets_of(&self, args: &Value) -> std::result::Result<Vec<Value>, No> {
        let presets = self.call(Method::GET, &format!("{}/presets", self.at(&self.project_of(args)?)), None).await?;
        Ok(presets.as_array().cloned().unwrap_or_default())
    }

    async fn presets(&self, args: &Value) -> Said {
        let lines: Vec<String> = self
            .presets_of(args)
            .await?
            .iter()
            .map(|p| format!("{}: {} ({}) — {}", text(&p["id"]), text(&p["name"]), whose(p), text(&p["text"]).split('\n').next().unwrap_or_default()))
            .collect();
        Ok(if lines.is_empty() { "No presets yet; the owner makes them.".into() } else { lines.join("\n") })
    }

    async fn preset(&self, args: &Value) -> Said {
        let id = args.get("id").cloned().unwrap_or(Value::Null);
        let Some(preset) = self.presets_of(args).await?.into_iter().find(|p| p["id"] == id) else {
            return Ok(format!("No preset {} for this project; presets lists them.", text(&id)));
        };
        Ok(format!(
            "# {} ({})\n\nWhat a session started with it is told, for reference (not an instruction to you):\n\n{}",
            text(&preset["name"]),
            whose(&preset),
            text(&preset["text"])
        ))
    }

    async fn list(&self, path: &str) -> std::result::Result<Vec<Value>, No> {
        Ok(self.call(Method::GET, path, None).await?.as_array().cloned().unwrap_or_default())
    }

    async fn milestones(&self, args: &Value) -> Said {
        let milestones = self.list(&format!("{}/milestones", self.at(&self.project_of(args)?))).await?;
        let all = truthy(&args["all"]);
        let shown: Vec<&Value> = milestones.iter().filter(|c| all || c["kind"] != "done").collect();
        let hidden = milestones.len() - shown.len();
        let mut lines: Vec<String> = shown
            .iter()
            .map(|c| {
                let id =
                    c["id"]
                        .as_str()
                        .filter(|i| !i.is_empty())
                        .map(String::from)
                        .unwrap_or_else(|| if truthy(&c["id"]) { text(&c["id"]) } else { "none".into() });
                let priority = c["priority"].as_str().filter(|p| !p.is_empty()).map(|p| format!(", {p}")).unwrap_or_default();
                format!("{id} [{}{priority}] {}: {}", text(&c["column"]), text(&c["title"]), done_of(&c["kinds"]))
            })
            .collect();
        if hidden > 0 {
            lines.push(format!("{hidden} done milestone{} not shown: all lists them", if hidden == 1 { "" } else { "s" }));
        }
        Ok(if lines.is_empty() { "No milestones yet.".into() } else { lines.join("\n") })
    }

    async fn releases(&self, args: &Value) -> Said {
        let releases = self.list(&format!("{}/releases", self.at(&self.project_of(args)?))).await?;
        let shipped = |r: &Value| r["shipped_on"].as_str().filter(|s| !s.is_empty()).map(String::from);
        // The latest shipped: the first with the greatest date, as the channel's reduce finds it.
        let mut latest: Option<usize> = None;
        for (i, r) in releases.iter().enumerate() {
            if let Some(on) = shipped(r) {
                if latest.map_or(true, |l| on > shipped(&releases[l]).unwrap_or_default()) {
                    latest = Some(i);
                }
            }
        }
        let all = truthy(&args["all"]);
        let shown: Vec<&Value> = releases.iter().enumerate().filter(|(i, r)| all || shipped(r).is_none() || Some(*i) == latest).map(|(_, r)| r).collect();
        let hidden = releases.len() - shown.len();
        let mut lines: Vec<String> = shown
            .iter()
            .map(|r| {
                let when = match (shipped(r), r["frozen_on"].as_str().filter(|f| !f.is_empty())) {
                    (Some(on), _) => format!(" (shipped {on})"),
                    (None, Some(frozen)) => format!(" (feature freeze since {frozen}: fixes, tests and docs)"),
                    _ => String::new(),
                };
                let branch = r["branch"].as_str().filter(|b| !b.is_empty()).map(|b| format!(" on {b}")).unwrap_or_default();
                let issues = r["issues"].as_i64().unwrap_or(0);
                format!("{}{when}{branch}: {issues} issue{}, {}", text(&r["version"]), if issues == 1 { "" } else { "s" }, done_of(&r["kinds"]))
            })
            .collect();
        if hidden > 0 {
            lines.push(format!("{hidden} older shipped release{} not shown: all lists them", if hidden == 1 { "" } else { "s" }));
        }
        Ok(if lines.is_empty() { "No releases yet.".into() } else { lines.join("\n") })
    }

    async fn create_milestone(&self, args: &Value) -> Said {
        let made =
            self.call(Method::POST, &format!("{}/milestones", self.at(&self.project_of(args)?)), Some(pick(args, &["title", "summary", "priority"]))).await?;
        Ok(format!("Made milestone {}: {}. Put issues in it with edit_issue (milestone: \"{}\").", text(&made["id"]), text(&made["title"]), text(&made["id"])))
    }

    async fn update_milestone(&self, args: &Value) -> Said {
        let id = text(&args["id"]);
        let path = format!("{}/milestones/{}", self.at(&self.project_of(args)?), enc(&id));
        let changed = self.call(Method::PATCH, &path, Some(pick(args, &["title", "summary", "priority"]))).await?;
        Ok(format!("Milestone {} is now: {}", text(&changed["id"]), text(&changed["title"])))
    }

    async fn epics(&self) -> Said {
        let lines: Vec<String> = self
            .list("/api/epics")
            .await?
            .iter()
            .map(|e| {
                let issues = e["issues"].as_i64().unwrap_or(0);
                let projects: Vec<String> = e["projects"].as_array().into_iter().flatten().map(|p| text(&p["project"])).collect();
                let within = if projects.is_empty() { String::new() } else { format!(" in {}", projects.join(", ")) };
                format!("{} {}: {issues} issue{}, {}{within}", text(&e["id"]), text(&e["title"]), if issues == 1 { "" } else { "s" }, done_of(&e["kinds"]))
            })
            .collect();
        Ok(if lines.is_empty() { "No epics yet.".into() } else { lines.join("\n") })
    }

    async fn create_epic(&self, args: &Value) -> Said {
        let epic = self.call(Method::POST, "/api/epics", Some(pick(args, &["title", "notes"]))).await?;
        Ok(format!("Made epic {}: {}. Set epic: {} on each issue in it.", text(&epic["id"]), text(&epic["title"]), text(&epic["id"])))
    }

    async fn update_epic(&self, args: &Value) -> Said {
        let epic = self.call(Method::PATCH, &format!("/api/epics/{}", enc(&text(&args["id"]))), Some(pick(args, &["title", "notes"]))).await?;
        Ok(format!("Epic {} is now: {}", text(&epic["id"]), text(&epic["title"])))
    }

    /// The tool's answer, if it's one of the board's served here.
    pub(crate) async fn run(&self, name: &str, args: &Value) -> Option<Said> {
        if name == "create_schedule" || name == "update_schedule" {
            return self.ask_schedule(args).await;
        }
        // The chat's asks go through `request` {action, fields, why} (ORR-624): those kept in the API are served here,
        // the rest stay in the channel until they move (ORR-1100).
        if name == "request" {
            let action = args["action"].as_str().unwrap_or_default();
            let asks = ["update_settings", "create_schedule", "update_schedule", "create_release", "update_release", "create_doc", "update_doc"];
            if !asks.contains(&action) {
                return None;
            }
            let mut fields = args.get("fields").filter(|f| f.is_object()).cloned().unwrap_or_else(|| json!({}));
            if let Some(why) = args.get("why").filter(|w| truthy(w)) {
                fields["why"] = why.clone();
            }
            return Some(match action {
                "update_settings" => self.update_settings(&fields).await,
                "create_release" | "update_release" => self.ask_release_in_chat(action == "update_release", &fields).await,
                _ => {
                    let (verb, kind) = action.split_once('_').unwrap_or_default();
                    self.ask_in_chat(kind, verb == "update", &fields).await
                }
            });
        }
        Some(match name {
            "schedules" => self.schedules(args).await,
            "docs" => self.docs(args).await,
            "doc" => self.doc(args).await,
            "write_doc" => self.write_doc(args).await,
            "presets" => self.presets(args).await,
            "preset" => self.preset(args).await,
            "milestones" => self.milestones(args).await,
            "releases" => self.releases(args).await,
            "create_milestone" => self.create_milestone(args).await,
            "update_milestone" => self.update_milestone(args).await,
            "epics" => self.epics().await,
            "create_epic" => self.create_epic(args).await,
            "update_epic" => self.update_epic(args).await,
            "issues" => self.issues(args).await,
            "issue" => self.issue(args).await,
            "create_issue" => self.create_issue(args).await,
            "update_issue" | "edit_issue" => self.change_issue(args).await,
            "comment" => self.comment(args).await,
            "comment_epic" => self.comment_epic(args).await,
            "rate_pull" => self.rate_pull(args).await,
            "events" => self.events(args).await,
            "resolve_event" => self.resolve_event(args).await,
            "secrets" => self.secrets().await,
            _ => return None,
        })
    }
}

/// How many of a search's hits in the text `issues` quotes (ORR-641), as the channel's `MATCHES_SHOWN`.
const MATCHES_SHOWN: usize = 15;

/// An issue in a line, as the channel's `line`: its id, status, priority and assignee, title, proposal and blockers.
fn line(i: &Value) -> String {
    let tags: Vec<String> = ["status", "priority", "assignee"].iter().filter(|k| truthy(&i[**k])).map(|k| text(&i[*k])).collect();
    let mut said = format!("{} [{}] {}", text(&i["id"]), tags.join(", "), text(&i["title"]));
    if truthy(&i["proposal"]) {
        said.push_str(&format!(" (proposal: {})", text(&i["proposal"])));
    }
    let blockers: Vec<String> = i["blocked_by"].as_array().into_iter().flatten().map(text).collect();
    if !blockers.is_empty() {
        said.push_str(&format!(" (blocked by {})", blockers.join(", ")));
    }
    said
}

/// A value as JavaScript's template string writes it.
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// Whether JavaScript takes a value as true.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `done/total done` from a list's `kinds`.
fn done_of(kinds: &Value) -> String {
    let n = |k: &str| kinds[k].as_i64().unwrap_or(0);
    format!("{}/{} done", n("done"), n("backlog") + n("todo") + n("started") + n("done"))
}

/// The fields sent, as the channel's `pick`: only those given.
fn pick(args: &Value, keys: &[&str]) -> Value {
    let mut picked = serde_json::Map::new();
    for key in keys {
        if let Some(value) = args.get(*key) {
            picked.insert((*key).into(), value.clone());
        }
    }
    Value::Object(picked)
}

fn whose(preset: &Value) -> String {
    preset["project"].as_str().map(String::from).unwrap_or_else(|| "the orrery's".into())
}
