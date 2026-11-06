// Changing an issue (ORR-927): the part of `updateIssue` in web/server/store/issues.ts that changes what an issue says,
// where it sits among its siblings and what it's under, its status and who it's with: `title`, `status` (or the old
// `plan`), `priority`, `assignee`, `notes`, `labels`, its tasks (`external`), its GitHub issues, its `parent`,
// `milestone`, `release` and `epic`, what it depends on, whether it's a `proposal` and its `choices`, the `model` and
// `effort` a session for it starts on, and its `position`. The router sends a `PATCH …/issues/{issue}` here only when it
// names none of the other fields (`wordsOnly`), so moving it to another project stays the Nuxt server's, and so does a
// session's change of status, as the session's lock on the issue (`claimed`) is the Nuxt server's. The rails are the
// store's: an agent changes only its person's issue, or its own proposal, moves one only under an issue that's its
// person's too, and hands one on only back to the owner.
use crate::changes;
use crate::comments::Comments;
use crate::db::sql;
use crate::docs::{js, stamp, Actor};
use crate::error::{ApiError, Result};
use crate::issues::{github_issue_of, github_repo, link_ref, Issues, GITHUB_OWN};
use regex::Regex;
use serde_json::Value;
use sqlx::Row;
use std::collections::{HashMap, VecDeque};
use std::sync::LazyLock;

/// The fields this takes, in the order `ISSUE_FIELDS` has them, which is the order its problems are listed in.
pub const WORDS: [&str; 19] = [
    "title",
    "status",
    "plan",
    "priority",
    "assignee",
    "labels",
    "external",
    "github_issues",
    "notes",
    "proposal",
    "choices",
    "parent",
    "milestone",
    "release",
    "epic",
    "depends_on",
    "model",
    "effort",
    "position",
];
/// The most issues one can depend on (`MAX_DEPENDS`).
const MAX_DEPENDS: usize = 50;
const PRIORITIES: [&str; 4] = ["P0", "P1", "P2", "P3"];
/// The plans from before statuses (`LEGACY_PLANS`): any of them puts an issue in Todo, null in Backlog.
const PLANS: [&str; 3] = ["now", "next", "later"];
/// The kinds a status is sent as (`KINDS`), and the words from before statuses (`LEGACY_KINDS`).
const KINDS: [&str; 5] = ["backlog", "todo", "started", "done", "canceled"];
const LEGACY_KINDS: [(&str, &str); 4] = [("doing", "started"), ("now", "todo"), ("next", "todo"), ("later", "todo")];
/// The kinds of status an issue is closed in (`CLOSED`).
const CLOSED: [&str; 2] = ["done", "canceled"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(best|opus|sonnet|haiku|fable|default|opusplan|claude-[a-z0-9.-]{1,56}(\[1m\])?)$").unwrap());
const MODEL_HINT: &str = "use best, opus, sonnet, haiku, fable, default, opusplan or a full id such as claude-sonnet-5-5";

/// What an edit sets: each `None` when it isn't sent, and `Some(None)` for one sent as null.
#[derive(Debug, Default, PartialEq)]
pub struct Words {
    pub title: Option<String>,
    /// A status's id, a kind, or a word from before statuses (`resolveStatus`).
    pub status: Option<String>,
    /// The old way to say Todo (any plan) or Backlog (null), with `status: "todo"` or none.
    pub plan: Option<Option<String>>,
    pub priority: Option<Option<String>>,
    /// As it was sent: `owner` is the owner's id (`assigneeOf`), and blank or null is nobody.
    pub assignee: Option<Option<String>>,
    pub labels: Option<Vec<String>>,
    pub external: Option<Vec<String>>,
    pub github_issues: Option<Vec<String>>,
    pub notes: Option<Option<String>>,
    pub parent: Option<Option<String>>,
    pub milestone: Option<Option<String>>,
    pub release: Option<Option<String>>,
    /// The epic it's part of, as it was sent: its number, `EPC-1` or its full id (ORR-995).
    pub epic: Option<Option<String>>,
    /// What it depends on, all of it (ORR-601): `Some(vec![])` for none.
    pub depends_on: Option<Vec<String>>,
    /// `pending` puts it (back) to the owner, null commits it.
    pub proposal: Option<Option<String>>,
    /// A proposal's choices as they're kept (`parseChoices`): `[]` for none.
    pub choices: Option<String>,
    pub model: Option<Option<String>>,
    pub effort: Option<Option<String>>,
    pub position: Option<f64>,
}

/// A list of strings as `checkInput` takes one (`strings`): none blank, each trimmed and once.
fn strings(key: &str, value: &Value, problems: &mut Vec<String>) -> Option<Vec<String>> {
    let listed = value.as_array().filter(|list| list.iter().all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty())));
    let Some(listed) = listed else {
        problems.push(format!("\"{key}\" should be a list of strings, not {}", js(value)));
        return None;
    };
    let mut kept: Vec<String> = vec![];
    for text in listed.iter().filter_map(Value::as_str).map(str::trim) {
        if !kept.iter().any(|k| k == text) {
            kept.push(text.to_string());
        }
    }
    Some(kept)
}

/// A string field that may be null, checked against its `values` or `pattern` as `checkInput` does.
fn text(key: &str, value: &Value, problems: &mut Vec<String>, check: impl Fn(&str) -> Option<String>) -> Option<Option<String>> {
    match value {
        Value::Null => Some(None),
        Value::String(sent) => match check(sent) {
            Some(problem) => {
                problems.push(problem);
                None
            }
            None => Some(Some(sent.clone())),
        },
        other => {
            problems.push(format!("\"{key}\" should be a string, not {}", js(other)));
            None
        }
    }
}

/// The body of a words-only edit, as `checkInput(body, ISSUE_FIELDS, true)` takes it: the router sends no other field,
/// so one here is refused as the store would refuse an unknown one.
pub fn check_words(body: &Value) -> Result<Words> {
    check_body(body, false)
}

/// The body of a new issue (`checkInput(body, ISSUE_FIELDS)`), as the router sends it: an edit's words, with a title.
pub fn check_new(body: &Value) -> Result<Words> {
    check_body(body, true)
}

fn check_body(body: &Value, new: bool) -> Result<Words> {
    let Some(object) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
    let mut problems = vec![];
    for key in object.keys() {
        if !WORDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", WORDS.join(", ")));
        }
    }
    let mut words = Words::default();
    for key in WORDS {
        let Some(value) = object.get(key) else {
            if new && key == "title" {
                problems.push("missing \"title\"".into());
            }
            continue;
        };
        let nullable = !matches!(key, "title" | "status" | "position");
        if value.is_null() && !nullable {
            problems.push(format!("\"{key}\" can't be null"));
            continue;
        }
        match key {
            "title" => match value.as_str() {
                Some(sent) if sent.trim().is_empty() => problems.push("\"title\" can't be empty".into()),
                Some(sent) => words.title = Some(sent.trim().to_string()),
                None => problems.push(format!("\"title\" should be a string, not {}", js(value))),
            },
            "status" => match value.as_str() {
                Some(sent) => words.status = Some(sent.to_string()),
                None => problems.push(format!("\"status\" should be a string, not {}", js(value))),
            },
            "plan" => {
                words.plan = text(key, value, &mut problems, |sent| {
                    (!PLANS.contains(&sent)).then(|| format!("\"plan\" is \"{sent}\", not one of {} (or null)", PLANS.join(", ")))
                })
            }
            "assignee" => words.assignee = text(key, value, &mut problems, |_| None),
            "labels" | "external" | "depends_on" if value.is_null() => {
                *match key {
                    "labels" => &mut words.labels,
                    "external" => &mut words.external,
                    _ => &mut words.depends_on,
                } = Some(vec![])
            }
            "labels" => words.labels = strings(key, value, &mut problems),
            "depends_on" => words.depends_on = strings(key, value, &mut problems),
            "external" => words.external = strings(key, value, &mut problems),
            "github_issues" if value.is_null() => words.github_issues = Some(vec![]),
            "github_issues" => {
                let listed = value
                    .as_array()
                    .filter(|list| list.iter().all(|v| v.as_u64().is_some_and(|n| n > 0 && v.is_u64()) || v.as_str().is_some_and(|s| !s.trim().is_empty())));
                match listed {
                    Some(listed) => {
                        words.github_issues = Some(listed.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), |s| s.trim().to_string())).collect())
                    }
                    None => problems.push(format!(
                        "\"github_issues\": should be a list of GitHub issues, each a number on the project's repo, owner/name#523 or a link to one, not {}",
                        js(value)
                    )),
                }
            }
            "priority" => {
                words.priority = text(key, value, &mut problems, |sent| {
                    (!PRIORITIES.contains(&sent)).then(|| format!("\"priority\" is \"{sent}\", not one of {} (or null)", PRIORITIES.join(", ")))
                })
            }
            "notes" => words.notes = text(key, value, &mut problems, |_| None),
            "proposal" => {
                words.proposal =
                    text(key, value, &mut problems, |sent| (sent != "pending").then(|| format!("\"proposal\" is \"{sent}\", not one of pending (or null)")))
            }
            "choices" if value.is_null() => words.choices = Some("[]".into()),
            "choices" => match crate::choices::parse_choices(value) {
                Ok(kept) => words.choices = Some(kept),
                Err(problem) => problems.push(format!("\"choices\": {problem}")),
            },
            "parent" => words.parent = text(key, value, &mut problems, |_| None),
            "milestone" => words.milestone = text(key, value, &mut problems, |_| None),
            "release" => words.release = text(key, value, &mut problems, |_| None),
            // `EPIC_REF`: a whole number or a string that isn't blank.
            "epic" => match value {
                Value::Null => words.epic = Some(None),
                Value::String(sent) if !sent.trim().is_empty() => words.epic = Some(Some(sent.trim().to_string())),
                Value::Number(n) if n.as_i64().is_some() || n.as_f64().is_some_and(|f| f.fract() == 0.0 && f.is_finite()) => {
                    words.epic = Some(Some(n.as_i64().map_or_else(|| format!("{}", n.as_f64().unwrap_or_default()), |i| i.to_string())))
                }
                other => problems.push(format!("\"epic\": should be an epic's number or id, such as 1 or \"EPC-1\", not {}", js(other))),
            },
            "model" => words.model = text(key, value, &mut problems, |sent| (!MODEL.is_match(sent)).then(|| format!("\"model\" is \"{sent}\"; {MODEL_HINT}"))),
            "effort" => {
                words.effort = text(key, value, &mut problems, |sent| {
                    (!EFFORTS.contains(&sent)).then(|| format!("\"effort\" is \"{sent}\", not one of {} (or null)", EFFORTS.join(", ")))
                })
            }
            _ => match value.as_f64() {
                Some(position) => words.position = Some(position),
                None => problems.push(format!("\"position\" should be a number, not {}", js(value))),
            },
        }
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(words)
}

/// A field, what it held, and what the edit sets it to (`None` when it's left as it is).
type Change<'a> = (&'a str, Option<&'a str>, Option<Option<&'a str>>);

/// What a column held before the edit: `None` for SQL null.
struct Before {
    title: String,
    status: String,
    priority: Option<String>,
    labels: Option<String>,
    external: Option<String>,
    github_issues: Option<String>,
    notes: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    assignee: Option<String>,
    proposal: Option<String>,
    created_person: Option<String>,
    parent: Option<String>,
    milestone: Option<String>,
    ships_in: Option<String>,
    epic: Option<i64>,
}

/// Where an edit puts the issue, as `updateIssue` works it out: each `None` when it's left as it is.
struct Placement {
    /// The parent it's under after the edit, and whether the edit sent one.
    parent: Option<String>,
    moved: bool,
    sent_parent: bool,
    milestone: Option<Option<String>>,
    release: Option<Option<String>>,
}

/// Set, as JavaScript tests a string: neither null nor empty.
fn named(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.is_empty())
}

/// What one change to many issues at once sets (`BULK_FIELDS`), with labels added and removed besides.
pub const BULK: [&str; 6] = ["status", "priority", "assignee", "milestone", "release", "epic"];

impl Comments<'_> {
    /// One issue's part of a change to many at once (`updateIssues`): `set`, and its labels with `add` added and
    /// `remove` taken off, each once, as one edit. Gives back its id when that made it urgent open work, as `edit_words`.
    pub async fn edit_one_of_many(
        &mut self,
        project: &str,
        sent: &str,
        set: &serde_json::Map<String, Value>,
        add: &[String],
        remove: &[String],
        actor: &Actor,
    ) -> Result<Option<String>> {
        let mut edit = set.clone();
        if !add.is_empty() || !remove.is_empty() {
            let issue = self.issue_id(project, sent).await?;
            self.issue_there(project, &issue).await?;
            let row = sqlx::query(&sql("SELECT labels FROM issues WHERE project = ? AND id = ?")).bind(project).bind(&issue).fetch_one(&mut *self.conn).await?;
            let now: Vec<String> = row.get::<Option<String>, _>("labels").and_then(|l| serde_json::from_str(&l).ok()).unwrap_or_default();
            let mut labels: Vec<String> = vec![];
            for label in now.into_iter().filter(|l| !remove.contains(l)).chain(add.iter().cloned()) {
                if !labels.contains(&label) {
                    labels.push(label);
                }
            }
            edit.insert("labels".into(), Value::from(labels));
        }
        self.edit_words(project, sent, &Value::Object(edit), actor).await
    }

    /// Makes an issue (`createIssue`) from an edit's words, with the project's next id, and notes it as `created`.
    /// An agent on the rails files a sub-issue only under its person's issue, and it's then theirs (taken up, when it's
    /// started), unless it's a proposal; one at the top stays nobody's, so it's refused started, closed or given to
    /// anyone but the owner. Gives back its id, and whether it's urgent open work (P0) to push, as `edit_words` does.
    pub async fn create_issue(&mut self, project: &str, body: &Value, actor: &Actor) -> Result<(String, bool)> {
        let row = Issues::new(&mut *self.conn).project(project).await?;
        let words = check_new(body)?;
        let parent = match words.parent.as_ref().and_then(|p| p.as_deref()).filter(|p| !p.is_empty()) {
            Some(sent) => Some(self.issue_id(project, sent).await?),
            None => None,
        };
        let milestone = match words.milestone.as_ref().and_then(|m| m.as_deref()).filter(|m| !m.is_empty()) {
            Some(sent) => Some(Issues::new(&mut *self.conn).resolve(project, sent, true).await?),
            None => None,
        };
        if let Some(parent) = &parent {
            self.issue_there(project, parent).await?;
            if milestone.is_some() {
                return Err(ApiError::bad_request("A sub-issue is in its parent's milestone; leave out \"milestone\" or \"parent\""));
            }
        }
        if let Some(id) = &milestone {
            if !Issues::new(&mut *self.conn).exists("SELECT 1 FROM milestones WHERE project = ? AND id = ?", &[project, id]).await? {
                return Err(ApiError::not_found(format!("No milestone \"{id}\" in {project}")));
            }
        }
        let release = match words.release.as_ref().and_then(|r| r.as_deref()).filter(|r| !r.is_empty()) {
            Some(version) => {
                Issues::new(&mut *self.conn).release_there(project, &row, version).await?;
                Some(version.to_string())
            }
            None => None,
        };
        let epic = match words.epic.as_ref().and_then(|e| e.as_deref()) {
            Some(sent) => Some(self.epic_id(sent).await?),
            None => None,
        };
        let github = match &words.github_issues {
            Some(sent) => self.github_issues_of(project, sent).await?,
            None => vec![],
        };
        let depends = match &words.depends_on {
            Some(refs) => Some(self.links_from(project, "", refs).await?),
            None => None,
        };
        if let (Some(parent), Some(depends)) = (&parent, &depends) {
            if depends.iter().any(|(p, i)| p == project && i == parent) {
                return Err(ApiError::bad_request(format!("{parent} is this issue's parent, so it can't depend on it")));
            }
        }
        let statuses = Issues::new(&mut *self.conn).statuses().await?;
        let status = resolve_status(&statuses, words.status.as_deref(), words.plan.as_ref().map(Option::as_deref))?;
        let proposed = words.proposal.as_ref().is_some_and(|p| p.as_deref() == Some("pending"));
        let mut assigned = if proposed {
            Some(self.owner_id().await?)
        } else {
            let name = words.assignee.clone().flatten().unwrap_or_default();
            let name = name.trim();
            if name.eq_ignore_ascii_case("owner") {
                Some(self.owner_id().await?)
            } else {
                (!name.is_empty()).then(|| name.to_string())
            }
        };
        let rails = self.rails_for(actor).await?;
        let person = rails.clone().flatten();
        let kind = statuses.iter().find(|s| s.id == status).map(|s| s.kind.clone());
        if let Some(rails) = rails.as_ref().filter(|_| !actor.untrusted) {
            // A follow-up under its person's issue is theirs too, unless it's a proposal, which waits on the owner. A
            // new issue with no parent is anyone's on the board to make, but stays nobody's, so it can't be made taken up.
            if let Some(parent) = &parent {
                let holder = self.assignee_of(project, parent).await?;
                self.must_hold(rails.as_deref(), parent, holder.as_deref(), "file a sub-issue under it").await?;
                if !proposed {
                    assigned = person.clone();
                }
            } else {
                if rails.is_none() {
                    self.must_hold(None, "a new issue", None, "make one").await?;
                }
                if !proposed {
                    let kept = self.railed_assignee(rails.as_deref(), "a new issue", Some(assigned.clone())).await?;
                    if kept.is_none() && assigned.is_some() {
                        return Err(ApiError::conflict("Only people assign: a new issue stays unassigned until one does"));
                    }
                    if kind.as_deref().is_some_and(|k| k == "started" || CLOSED.contains(&k)) {
                        return Err(ApiError::conflict(format!(
                            "A new issue is assigned to nobody, so this session can't make it {status}; leave it in Todo or Backlog for a person to assign"
                        )));
                    }
                }
            }
        }
        let taken = parent.is_some() && person.is_some() && !proposed && kind.as_deref() == Some("started");
        let listed = |list: &[String]| serde_json::to_string(list).unwrap_or_default();
        let labels = listed(words.labels.as_deref().unwrap_or_default());
        let external = listed(words.external.as_deref().unwrap_or_default());
        let github = listed(&github);
        changes::begin(self.conn).await?;
        let done: Result<String> = async {
            let id = self.next_issue_id(project).await?;
            let position = match words.position {
                Some(position) => position,
                None => {
                    let found = sqlx::query(&sql("SELECT CAST(max(position) AS DOUBLE PRECISION) AS n FROM issues WHERE project = ?"))
                        .bind(project)
                        .fetch_one(&mut *self.conn)
                        .await?;
                    found.get::<Option<f64>, _>("n").unwrap_or(-1.0) + 1.0
                }
            };
            let now = stamp();
            let query = sql("INSERT INTO issues (project, id, title, status, priority, assignee, labels, external, github_issues, notes, proposal, choices, parent, milestone, ships_in, epic, \
                position, created_by, session_name, owned, created_at, updated_at, created_person, claimed_by, claimed_at, model, effort) \
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            let insert = sqlx::query(&query)
                .bind(project)
                .bind(&id)
                .bind(words.title.clone().unwrap_or_default())
                .bind(&status)
                .bind(words.priority.clone().flatten())
                .bind(assigned.clone())
                .bind(&labels)
                .bind(&external)
                .bind(&github)
                .bind(words.notes.clone().flatten())
                .bind(words.proposal.clone().flatten())
                .bind(words.choices.clone().unwrap_or_else(|| "[]".into()))
                .bind(parent.clone())
                .bind(milestone.clone())
                .bind(release.clone())
                .bind(epic);
            let insert = if position.fract() == 0.0 && position.abs() < 9e15 { insert.bind(position as i64) } else { insert.bind(position) };
            insert
                .bind(&actor.name)
                .bind(actor.session.as_deref())
                .bind(i64::from(actor.owner))
                .bind(&now)
                .bind(&now)
                .bind(person.clone())
                .bind(if taken { person.clone() } else { None })
                .bind(if taken { Some(now.clone()) } else { None })
                .bind(words.model.clone().flatten())
                .bind(words.effort.clone().flatten())
                .execute(&mut *self.conn)
                .await?;
            self.record_field(project, &id, actor, "created", None, None).await?;
            if let Some(depends) = &depends {
                self.set_links(project, &id, depends, actor).await?;
            }
            self.touch_project(project).await?;
            Ok(id)
        }
        .await;
        let mut changed = vec![project.to_string()];
        for (other, _) in depends.iter().flatten() {
            if !changed.contains(other) {
                changed.push(other.clone());
            }
        }
        self.effects.changed = changed;
        let id = changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let closed = kind.as_deref().is_some_and(|k| CLOSED.contains(&k));
        let urgent = words.priority.clone().flatten().as_deref() == Some("P0") && words.proposal.clone().flatten().is_none() && !closed;
        Ok((id, urgent && (actor.owner || actor.person.is_some())))
    }

    /// The project's next issue id, `KEY-n`, its number taken in one statement so two writers never get the same one;
    /// one that's still an issue's id or an old one is skipped (`nextId`).
    async fn next_issue_id(&mut self, project: &str) -> Result<String> {
        let key: String = sqlx::query(&sql("SELECT key FROM projects WHERE id = ?")).bind(project).fetch_one(&mut *self.conn).await?.get("key");
        loop {
            let row = sqlx::query(&sql("UPDATE projects SET next_number = next_number + 1 WHERE id = ? RETURNING CAST(next_number - 1 AS BIGINT) AS n"))
                .bind(project)
                .fetch_one(&mut *self.conn)
                .await?;
            let id = format!("{key}-{}", row.get::<i64, _>("n"));
            let taken =
                sqlx::query(&sql("SELECT 1 FROM issues WHERE project = ? AND id = ? UNION SELECT 1 FROM issue_aliases WHERE project = ? AND alias = ?"))
                    .bind(project)
                    .bind(&id)
                    .bind(project)
                    .bind(&id)
                    .fetch_optional(&mut *self.conn)
                    .await?;
            if taken.is_none() {
                return Ok(id);
            }
        }
    }

    /// Changes the issue's own words (`updateIssue`, for `WORDS` only), noting each changed field in its activity and
    /// telling it, without a title's or a link's words, as an outsider may have written them. 409 for an agent on one
    /// that isn't its person's, unless it's its own proposal. Gives back the issue's id when the edit made it urgent open
    /// work it wasn't (P0, `urgent`), for the Nuxt server to push to the sessions, as only it reaches them.
    pub async fn edit_words(&mut self, project: &str, sent: &str, body: &Value, actor: &Actor) -> Result<Option<String>> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let words = check_words(body)?;
        let row = sqlx::query(&sql(
            "SELECT title, status, priority, labels, external, github_issues, notes, model, effort, assignee, proposal, created_person, parent, milestone, ships_in, CAST(epic AS BIGINT) AS epic FROM issues WHERE project = ? AND id = ?",
        ))
        .bind(project)
        .bind(&issue)
        .fetch_one(&mut *self.conn)
        .await?;
        let row = Before {
            title: row.get("title"),
            status: row.get("status"),
            priority: row.get("priority"),
            labels: row.get("labels"),
            external: row.get("external"),
            github_issues: row.get("github_issues"),
            notes: row.get("notes"),
            model: row.get("model"),
            effort: row.get("effort"),
            assignee: row.get("assignee"),
            proposal: row.get("proposal"),
            created_person: row.get("created_person"),
            parent: row.get("parent"),
            milestone: row.get("milestone"),
            ships_in: row.get("ships_in"),
            epic: row.get::<Option<i64>, _>("epic"),
        };
        if words.proposal == Some(None) && !actor.owner {
            if let Some(proposal) = row.proposal.as_deref() {
                let state = match proposal {
                    "pending" => "waiting on them",
                    "changes" => "waiting on changes",
                    _ => "rejected",
                };
                return Err(ApiError::refused_for("issues.edit", format!("Committing {issue} is the owner's call until they approve it: it's {state}")));
            }
        }
        // Put up again, it's the owner's to decide, so it's theirs; a claim on it ends when that reassigns it.
        let pending = words.proposal.as_ref().is_some_and(|p| p.as_deref() == Some("pending"));
        // While it waits on the owner, it isn't work yet: an agent can still comment, edit it and put it up again.
        let moves: Vec<&str> = [
            ("status", words.status.is_some()),
            ("plan", words.plan.is_some()),
            ("assignee", words.assignee.is_some() && !pending),
            ("release", words.release.is_some()),
        ]
        .into_iter()
        .filter_map(|(field, sent)| sent.then_some(field))
        .collect();
        if !moves.is_empty() && !actor.owner && matches!(row.proposal.as_deref(), Some("pending" | "changes")) {
            let settings = crate::settings::Settings::new(&mut *self.conn).get().await?;
            if settings["restrict_proposals"].as_bool().unwrap_or(true) {
                let (named, verb) = match moves.as_slice() {
                    [one] => (one.to_string(), "isn't"),
                    [rest @ .., last] => (format!("{} and {last}", rest.join(", ")), "aren't"),
                    [] => unreachable!(),
                };
                return Err(ApiError::refused_for(
                    "issues.edit",
                    format!("{issue} is a proposal waiting on the owner, so its {named} {verb} yours to change until they approve it"),
                ));
            }
        }
        let place = self.placement(project, &issue, &words, &row).await?;
        let epic = match &words.epic {
            None => None,
            Some(None) => Some(None),
            Some(Some(sent)) => Some(Some(self.epic_id(sent).await?)),
        };
        let statuses = Issues::new(&mut *self.conn).statuses().await?;
        let status = if words.status.is_some() || words.plan.is_some() {
            Some(resolve_status(&statuses, words.status.as_deref(), words.plan.as_ref().map(Option::as_deref))?)
        } else {
            None
        };
        let mut assignee = if pending {
            Some(Some(self.owner_id().await?))
        } else {
            match &words.assignee {
                None => None,
                Some(sent) => {
                    let name = sent.as_deref().unwrap_or_default().trim();
                    Some(if name.eq_ignore_ascii_case("owner") { Some(self.owner_id().await?) } else { (!name.is_empty()).then(|| name.to_string()) })
                }
            }
        };
        let rails = self.rails_for(actor).await?;
        if let Some(rails) = &rails {
            // An agent's own proposal is its to edit and put up again, though it waits on the owner.
            let own_proposal = rails.is_some() && row.proposal.is_some() && row.created_person == *rails;
            if !own_proposal {
                self.must_hold(rails.as_deref(), &issue, row.assignee.as_deref(), "change it").await?;
            }
            if named(&place.parent) && place.parent != row.parent {
                let parent = place.parent.as_deref().unwrap_or_default();
                let assignee = self.assignee_of(project, parent).await?;
                self.must_hold(rails.as_deref(), parent, assignee.as_deref(), "move an issue under it").await?;
            }
            if !pending {
                assignee = self.railed_assignee(rails.as_deref(), &issue, assignee).await?;
            }
        }
        // A claim ends with the issue closed or reassigned; reopening it doesn't bring it back.
        let to_kind = status.as_ref().and_then(|id| statuses.iter().find(|s| s.id == *id)).map(|s| s.kind.clone());
        let reassigned =
            assignee.as_ref().is_some_and(|a| a.as_deref().unwrap_or_default().to_lowercase() != row.assignee.as_deref().unwrap_or_default().to_lowercase());
        let ended = reassigned || to_kind.as_deref().is_some_and(|k| CLOSED.contains(&k));
        // Started by an agent on the rails, it's taken up for its person, as long as nobody else holds it.
        let claim_for = rails.flatten().filter(|_| to_kind.as_deref() == Some("started") && !ended);
        let github = match &words.github_issues {
            Some(sent) => Some(self.github_issues_of(project, sent).await?),
            None => None,
        };
        let listed = |list: &Option<Vec<String>>| list.as_ref().map(|l| serde_json::to_string(l).unwrap_or_default());
        let (labels, external, github) = (listed(&words.labels), listed(&words.external), listed(&github));
        let depends = match &words.depends_on {
            Some(refs) => Some(self.links_from(project, &issue, refs).await?),
            None => None,
        };
        // The projects whose boards show this issue's links, those it's to depend on too: theirs change with it.
        let mut linked: Vec<String> = depends.iter().flatten().map(|(p, _)| p.clone()).collect();
        for other in self.linked_projects(project, &issue).await? {
            if !linked.contains(&other) {
                linked.push(other);
            }
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            if let Some(person) = &claim_for {
                self.claim_for(project, &issue, person, row.assignee.as_deref()).await?;
            }
            // A sub-issue is in its parent's milestone, so a new parent says it all.
            let placed: Change = if place.moved {
                ("parent", row.parent.as_deref(), Some(place.parent.as_deref()))
            } else {
                ("milestone", row.milestone.as_deref(), place.milestone.as_ref().map(Option::as_deref))
            };
            let (epic_before, epic_after) = (row.epic.map(|e| e.to_string()), epic.map(|e| e.map(|e| e.to_string())));
            let changed: [Change; 14] = [
                ("title", Some(row.title.as_str()), words.title.as_deref().map(Some)),
                ("status", Some(row.status.as_str()), status.as_deref().map(Some)),
                ("priority", row.priority.as_deref(), words.priority.as_ref().map(Option::as_deref)),
                ("assignee", row.assignee.as_deref(), assignee.as_ref().map(Option::as_deref)),
                ("labels", row.labels.as_deref(), labels.as_deref().map(Some)),
                ("external", row.external.as_deref(), external.as_deref().map(Some)),
                ("github_issues", row.github_issues.as_deref(), github.as_deref().map(Some)),
                ("notes", row.notes.as_deref(), words.notes.as_ref().map(Option::as_deref)),
                ("proposal", row.proposal.as_deref(), words.proposal.as_ref().map(Option::as_deref)),
                placed,
                ("release", row.ships_in.as_deref(), place.release.as_ref().map(Option::as_deref)),
                ("epic", epic_before.as_deref(), epic_after.as_ref().map(Option::as_deref)),
                ("model", row.model.as_deref(), words.model.as_ref().map(Option::as_deref)),
                ("effort", row.effort.as_deref(), words.effort.as_ref().map(Option::as_deref)),
            ];
            let mut set: Vec<(&str, Option<String>)> = vec![];
            for (field, before, after) in changed {
                let Some(after) = after else { continue };
                // The release an issue ships in is kept as `ships_in`, and a milestone is written whether or not the
                // new parent is noted in its place; a parent only when the edit sends one.
                if !matches!(field, "parent" | "milestone" | "release" | "epic") {
                    set.push((field, after.map(Into::into)));
                }
                if after == before {
                    continue;
                }
                // A description's words aren't kept in the activity, only that it changed; nor told, with a title's
                // and its links', as an outsider may have written them.
                match field {
                    "notes" => self.record_field(project, &issue, actor, field, None, None).await?,
                    "title" | "external" | "github_issues" => self.record_quietly(project, &issue, actor, field, before, after).await?,
                    _ => self.record_field(project, &issue, actor, field, before, after).await?,
                }
            }
            if place.sent_parent {
                set.push(("parent", place.parent.clone()));
            }
            if let Some(milestone) = &place.milestone {
                set.push(("milestone", milestone.clone()));
            }
            if let Some(release) = &place.release {
                set.push(("ships_in", release.clone()));
            }
            let mut columns: Vec<String> = set.iter().map(|(field, _)| format!("{field} = ?")).collect();
            // Put up again, it waits on a new decision.
            if pending {
                columns.extend(["decided_by", "decided_at", "decision_note", "picks", "explore"].map(|c| format!("{c} = NULL")));
            }
            if ended {
                columns.extend(["claimed_by", "claimed_at", "claimed_session"].map(|c| format!("{c} = NULL")));
            }
            if words.choices.is_some() {
                columns.push("choices = ?".into());
            }
            if epic.is_some() {
                columns.push("epic = ?".into());
            }
            if words.position.is_some() {
                columns.push("position = ?".into());
            }
            columns.push("updated_at = ?".into());
            let query = sql(&format!("UPDATE issues SET {} WHERE project = ? AND id = ?", columns.join(", ")));
            let mut update = sqlx::query(&query);
            for (_, value) in &set {
                update = update.bind(value.clone());
            }
            if let Some(choices) = &words.choices {
                update = update.bind(choices.clone());
            }
            if let Some(epic) = epic {
                update = update.bind(epic);
            }
            if let Some(position) = words.position {
                update = if position.fract() == 0.0 && position.abs() < 9e15 { update.bind(position as i64) } else { update.bind(position) };
            }
            update.bind(stamp()).bind(project).bind(&issue).execute(&mut *self.conn).await?;
            if let Some(depends) = &depends {
                self.set_links(project, &issue, depends, actor).await?;
            }
            self.touch_project(project).await
        }
        .await;
        let mut changed = vec![project.to_string()];
        for other in linked {
            if !changed.contains(&other) {
                changed.push(other);
            }
        }
        self.effects.changed = changed;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        // Urgent work is a committed P0 that isn't closed: made so by a priority, by committing a P0 proposal, or by
        // opening a closed P0 again.
        let closed = |id: &str| statuses.iter().any(|s| s.id == id && CLOSED.contains(&s.kind.as_str()));
        let priority = words.priority.clone().unwrap_or_else(|| row.priority.clone());
        let proposal = words.proposal.clone().unwrap_or_else(|| row.proposal.clone());
        let urgent = priority.as_deref() == Some("P0") && proposal.is_none() && !closed(status.as_deref().unwrap_or(&row.status));
        let was_urgent = row.priority.as_deref() == Some("P0") && row.proposal.is_none() && !closed(&row.status);
        Ok((urgent && !was_urgent && (actor.owner || actor.person.is_some())).then_some(issue))
    }

    /// An agent's assignee (`railedAssignee`): what it may hand on, back to the owner or letting go, with `claude` and
    /// its own person being who the issue is with already. Nobody else, as people assign.
    async fn railed_assignee(&mut self, person: Option<&str>, issue: &str, assignee: Option<Option<String>>) -> Result<Option<Option<String>>> {
        let Some(Some(sent)) = &assignee else { return Ok(assignee) };
        let id = sent.to_lowercase();
        if id == "claude" || Some(id.as_str()) == person {
            return Ok(None);
        }
        if id == self.owner_id().await? {
            return Ok(assignee);
        }
        Err(ApiError::conflict(format!("Only people assign: this session can't give {issue} to {sent}")))
    }

    /// Takes up an issue for `person`, only if it's still assigned as the rails read it and nobody else holds it
    /// (`claimFor`): one conditional write, so a reassignment or another server can't get in between.
    async fn claim_for(&mut self, project: &str, issue: &str, person: &str, assignee: Option<&str>) -> Result<()> {
        let done = sqlx::query(&sql(
            "UPDATE issues SET claimed_by = ?, claimed_at = ? WHERE project = ? AND id = ? AND coalesce(assignee, '') = ? AND (claimed_by IS NULL OR claimed_by = ?)",
        ))
        .bind(person)
        .bind(stamp())
        .bind(project)
        .bind(issue)
        .bind(assignee.unwrap_or_default())
        .bind(person)
        .execute(&mut *self.conn)
        .await?;
        if done.rows_affected() == 0 {
            return Err(ApiError::conflict(format!("{issue} has just been taken or reassigned; read it again, or pick another issue")));
        }
        Ok(())
    }

    /// Where the edit puts the issue (`updateIssue`): under a parent there is, that isn't it or under it, and then in no
    /// milestone of its own; lifted to the top, in its root's milestone unless one is sent; in a milestone and release
    /// there are. Refused as the store refuses each, in its order.
    async fn placement(&mut self, project: &str, issue: &str, words: &Words, row: &Before) -> Result<Placement> {
        let parent = match &words.parent {
            None => row.parent.clone(),
            Some(None) => None,
            Some(Some(sent)) => Some(self.issue_id(project, sent).await?),
        };
        let mut milestone = match &words.milestone {
            None => None,
            Some(None) => Some(None),
            Some(Some(sent)) => Some(Some(Issues::new(&mut *self.conn).resolve(project, sent, true).await?)),
        };
        if named(&parent) {
            if milestone.as_ref().is_some_and(named) {
                return Err(ApiError::bad_request("A sub-issue is in its parent's milestone; leave out \"milestone\" or set \"parent\" to null"));
            }
            let parent = parent.as_deref().unwrap_or_default();
            self.issue_there(project, parent).await?;
            let mut up = Some(parent.to_string());
            while let Some(at) = up.filter(|u| !u.is_empty()) {
                if at == issue {
                    let whose = if at == parent { "this issue" } else { "under this issue" };
                    return Err(ApiError::bad_request(format!("{parent} is {whose}, so it can't be its parent")));
                }
                self.issue_there(project, &at).await?;
                up = self.parent_of(project, &at).await?;
            }
            milestone = Some(None);
        } else if milestone.is_none() && named(&row.parent) {
            // Lifted to the top, it's in the milestone its root was in.
            let mut root = row.parent.clone().unwrap_or_default();
            while let Some(up) = self.parent_of(project, &root).await?.filter(|u| !u.is_empty()) {
                root = up;
            }
            let found = sqlx::query(&sql("SELECT milestone FROM issues WHERE project = ? AND id = ?"))
                .bind(project)
                .bind(&root)
                .fetch_optional(&mut *self.conn)
                .await?;
            let found = found.ok_or_else(|| ApiError::not_found(format!("No issue {root} in {project}")))?;
            milestone = Some(found.get("milestone"));
        }
        if let Some(Some(id)) = milestone.as_ref().filter(|m| named(m)) {
            if !Issues::new(&mut *self.conn).exists("SELECT 1 FROM milestones WHERE project = ? AND id = ?", &[project, id]).await? {
                return Err(ApiError::not_found(format!("No milestone \"{id}\" in {project}")));
            }
        }
        if let Some(Some(version)) = &words.release {
            let mut issues = Issues::new(&mut *self.conn);
            let row = issues.project(project).await?;
            issues.release_there(project, &row, version).await?;
        }
        let moved = words.parent.is_some() && parent != row.parent;
        Ok(Placement { parent, moved, sent_parent: words.parent.is_some(), milestone, release: words.release.clone() })
    }

    /// The epic sent as its number, `EPC-1` or its full id (`epicRow`, ORR-995), 404 when there's none.
    async fn epic_id(&mut self, sent: &str) -> Result<i64> {
        let settings = crate::settings::Settings::new(&mut *self.conn).get().await?;
        let found = match epic_number(sent, settings["uid"].as_str().unwrap_or_default()).and_then(|n| n.parse::<i64>().ok()) {
            Some(id) => sqlx::query(&sql("SELECT id FROM epics WHERE id = ?")).bind(id).fetch_optional(&mut *self.conn).await?.map(|_| id),
            None => None,
        };
        found.ok_or_else(|| ApiError::not_found(format!("No epic {sent}: GET /api/epics lists them")))
    }

    /// The issue's parent, or `None` at the top.
    async fn parent_of(&mut self, project: &str, issue: &str) -> Result<Option<String>> {
        let row = sqlx::query(&sql("SELECT parent FROM issues WHERE project = ? AND id = ?")).bind(project).bind(issue).fetch_optional(&mut *self.conn).await?;
        Ok(row.and_then(|r| r.get("parent")))
    }

    /// Whom the issue is assigned to.
    async fn assignee_of(&mut self, project: &str, issue: &str) -> Result<Option<String>> {
        let row = sqlx::query(&sql("SELECT assignee FROM issues WHERE project = ? AND id = ?")).bind(project).bind(issue).fetch_one(&mut *self.conn).await?;
        Ok(row.get("assignee"))
    }

    /// The GitHub issues as they're kept (`githubIssuesOf`): each `owner/name#523`, once whatever its case, refused
    /// when one isn't a GitHub issue.
    async fn github_issues_of(&mut self, project: &str, sent: &[String]) -> Result<Vec<String>> {
        let repo = sqlx::query(&sql("SELECT repo FROM projects WHERE id = ?")).bind(project).fetch_one(&mut *self.conn).await?;
        let repo = github_repo(repo.get::<Option<String>, _>("repo").as_deref());
        let mut kept: Vec<String> = vec![];
        for issue in sent {
            let Some(found) = github_issue_of(issue, repo.as_deref()) else {
                return Err(ApiError::bad_request(if GITHUB_OWN.is_match(issue) {
                    format!("{project}'s repo isn't on GitHub, so say whose issue {issue} is: owner/name#{}", issue.strip_prefix('#').unwrap_or(issue))
                } else {
                    format!(
                        "\"{issue}\" isn't a GitHub issue: send its number on {}, owner/name#523 or its link",
                        repo.as_deref().unwrap_or("the project's repo")
                    )
                }));
            };
            if !kept.iter().any(|k| k.to_lowercase() == found.to_lowercase()) {
                kept.push(found);
            }
        }
        Ok(kept)
    }

    /// The issues `depends_on` names, checked (`linksFrom`, ORR-601): each there (an id it had before finds it), in this
    /// project or another, not the issue itself, not its parent or a sub-issue, and not one that already depends on it,
    /// however far down, which would make a loop nothing could start.
    async fn links_from(&mut self, project: &str, issue: &str, refs: &[String]) -> Result<Vec<(String, String)>> {
        let mut links: Vec<(String, String)> = vec![];
        for sent in refs {
            let (on_project, on_id) = match sent.split_once('/') {
                Some((p, i)) => (p.trim().to_string(), i.trim().to_string()),
                None => (project.to_string(), sent.trim().to_string()),
            };
            if on_project.is_empty() || on_id.is_empty() {
                return Err(ApiError::bad_request(format!("\"{sent}\" in \"depends_on\" isn't an issue: use its id, or project/ID for another project's")));
            }
            let on_id = self.issue_id(&on_project, &on_id).await?;
            self.issue_there(&on_project, &on_id).await?;
            if on_project == project && on_id == issue {
                return Err(ApiError::bad_request("An issue can't depend on itself"));
            }
            if !links.iter().any(|(p, i)| *p == on_project && *i == on_id) {
                links.push((on_project, on_id));
            }
        }
        if links.len() > MAX_DEPENDS {
            return Err(ApiError::bad_request(format!("An issue can depend on {MAX_DEPENDS} issues at most")));
        }
        // A new issue (`linksFrom` with no id) has no parent yet, and nothing depends on it.
        if issue.is_empty() {
            return Ok(links);
        }
        // A sub-issue and its parent already go together: one waiting on the other could never start.
        let parent_of = async |conn: &mut sqlx::AnyConnection, id: &str| -> Result<Option<String>> {
            let row = sqlx::query(&sql("SELECT parent FROM issues WHERE project = ? AND id = ?")).bind(project).bind(id).fetch_one(&mut *conn).await?;
            Ok(row.get("parent"))
        };
        let parent = parent_of(&mut *self.conn, issue).await?;
        for (_, on) in links.iter().filter(|(p, _)| p == project) {
            if parent.as_deref() == Some(on.as_str()) || parent_of(&mut *self.conn, on).await?.as_deref() == Some(issue) {
                return Err(ApiError::bad_request(format!("{on} and {issue} are a parent and its sub-issue, so one can't depend on the other")));
            }
        }
        for (on_project, on_id) in &links {
            if let Some(path) = self.depends_path((on_project, on_id), (project, issue)).await? {
                let through = if path.len() > 2 {
                    format!(" (through {})", path[1..path.len() - 1].iter().map(|(p, i)| link_ref(project, p, i)).collect::<Vec<_>>().join(", "))
                } else {
                    String::new()
                };
                return Err(ApiError::bad_request(format!(
                    "{} already depends on {issue}{through}, so {issue} can't depend on it",
                    link_ref(project, on_project, on_id)
                )));
            }
        }
        Ok(links)
    }

    /// The chain from `from` to `to` along what each depends on, if there's one, both ends included (`dependsPath`).
    async fn depends_path(&mut self, from: (&str, &str), to: (&str, &str)) -> Result<Option<Vec<(String, String)>>> {
        let from = (from.0.to_string(), from.1.to_string());
        let mut came: HashMap<(String, String), Option<(String, String)>> = HashMap::from([(from.clone(), None)]);
        let mut queue = VecDeque::from([from]);
        while let Some(at) = queue.pop_front() {
            if at.0 == to.0 && at.1 == to.1 {
                let mut path = vec![at.clone()];
                let mut back = came.get(&at).cloned().flatten();
                while let Some(step) = back {
                    back = came.get(&step).cloned().flatten();
                    path.insert(0, step);
                }
                return Ok(Some(path));
            }
            let next = sqlx::query(&sql("SELECT on_project AS project, on_issue AS id FROM issue_links WHERE project = ? AND issue = ?"))
                .bind(&at.0)
                .bind(&at.1)
                .fetch_all(&mut *self.conn)
                .await?;
            for row in next {
                let step: (String, String) = (row.get("project"), row.get("id"));
                if came.contains_key(&step) {
                    continue;
                }
                came.insert(step.clone(), Some(at.clone()));
                queue.push_back(step);
            }
        }
        Ok(None)
    }

    /// Makes `links` what the issue depends on, each one added or dropped once, in its activity as `depends` (`setLinks`).
    async fn set_links(&mut self, project: &str, issue: &str, links: &[(String, String)], actor: &Actor) -> Result<()> {
        let before: Vec<(String, String)> = sqlx::query(&sql(
            "SELECT on_project AS project, on_issue AS id FROM issue_links WHERE project = ? AND issue = ? ORDER BY created_at, on_project, on_issue",
        ))
        .bind(project)
        .bind(issue)
        .fetch_all(&mut *self.conn)
        .await?
        .iter()
        .map(|r| (r.get("project"), r.get("id")))
        .collect();
        let now = stamp();
        for gone in before.iter().filter(|b| !links.contains(b)) {
            sqlx::query(&sql("DELETE FROM issue_links WHERE project = ? AND issue = ? AND on_project = ? AND on_issue = ?"))
                .bind(project)
                .bind(issue)
                .bind(&gone.0)
                .bind(&gone.1)
                .execute(&mut *self.conn)
                .await?;
        }
        let added: Vec<&(String, String)> = links.iter().filter(|l| !before.contains(l)).collect();
        for (on_project, on_id) in &added {
            sqlx::query(&sql("INSERT INTO issue_links (project, issue, on_project, on_issue, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"))
                .bind(project)
                .bind(issue)
                .bind(on_project)
                .bind(on_id)
                .bind(&actor.name)
                .bind(i64::from(actor.owner))
                .bind(&now)
                .execute(&mut *self.conn)
                .await?;
        }
        let refs = |list: &[&(String, String)]| {
            (!list.is_empty()).then(|| serde_json::to_string(&list.iter().map(|(p, i)| link_ref(project, p, i)).collect::<Vec<_>>()).unwrap_or_default())
        };
        let kept: Vec<&(String, String)> = before.iter().filter(|b| links.contains(b)).chain(added).collect();
        let was = refs(&before.iter().collect::<Vec<_>>());
        let now = refs(&kept);
        // `record` notes only what changed.
        if was != now {
            self.record_field(project, issue, actor, "depends", was.as_deref(), now.as_deref()).await?;
        }
        Ok(())
    }

    /// The projects whose boards show this issue's links (`linkedProjects`): theirs change with it, as its own does.
    async fn linked_projects(&mut self, project: &str, issue: &str) -> Result<Vec<String>> {
        let rows = sqlx::query(&sql(
            "SELECT on_project AS project FROM issue_links WHERE project = ? AND issue = ? UNION SELECT project FROM issue_links WHERE on_project = ? AND on_issue = ?",
        ))
        .bind(project)
        .bind(issue)
        .bind(project)
        .bind(issue)
        .fetch_all(&mut *self.conn)
        .await?;
        Ok(rows.iter().map(|r| r.get("project")).collect())
    }

    /// Notes a field's change in the issue's activity, with its values, and tells only that it changed (`record`).
    async fn record_quietly(&mut self, project: &str, issue: &str, actor: &Actor, field: &str, before: Option<&str>, after: Option<&str>) -> Result<()> {
        self.record_field(project, issue, actor, field, before, after).await?;
        if let Some(told) = self.effects.told.last_mut() {
            told.from = None;
            told.to = None;
        }
        Ok(())
    }
}

/// The status an issue gets from what was sent (`resolveStatus`): a status's id, a kind (its first status), or the words
/// from before statuses (`doing`; `todo` with a `plan`, which is Todo, or null for Backlog).
fn resolve_status(statuses: &[crate::issues::Status], status: Option<&str>, plan: Option<Option<&str>>) -> Result<String> {
    let first = |kind: &str| statuses.iter().find(|s| s.kind == kind).map(|s| s.id.clone()).ok_or_else(|| ApiError::internal(format!("a {kind} status")));
    if let Some(plan) = plan {
        if status.is_none() || status == Some("todo") {
            return first(if plan.is_some() { "todo" } else { "backlog" });
        }
    }
    let Some(text) = status else { return first("backlog") };
    if statuses.iter().any(|s| s.id == text) {
        return Ok(text.to_string());
    }
    if KINDS.contains(&text) {
        return first(text);
    }
    if let Some((_, kind)) = LEGACY_KINDS.iter().find(|(old, _)| *old == text) {
        return first(kind);
    }
    let ids: Vec<&str> = statuses.iter().map(|s| s.id.as_str()).collect();
    Err(ApiError::bad_request(format!("\"status\" is \"{text}\", not one of {} (or a kind: {})", ids.join(", "), KINDS.join(", "))))
}

/// An epic's number from any form of its id (`numberOf`): `14`, `EPC-14` in any case, or the full `EPC-14-x7k2m9qd`;
/// `None` for anything else, a full id from another board included.
pub(crate) fn epic_number(sent: &str, uid: &str) -> Option<String> {
    let digits = |s: &str| (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.to_string());
    let after_prefix = |s: &str| s.get(..4).filter(|p| p.eq_ignore_ascii_case("EPC-")).and_then(|_| s.get(4..)).map(str::to_string);
    let sent = sent.trim();
    if let Some(number) = digits(sent) {
        return Some(number);
    }
    // `shortId`: the id between the prefix and `-<uid>`.
    let tail = format!("-{uid}");
    let inner = after_prefix(sent)
        .filter(|rest| !uid.is_empty() && rest.len() > tail.len() && rest.ends_with(&tail))
        .map(|rest| rest[..rest.len() - tail.len()].to_string());
    // `shownNumber`, of the inner id or else of what was sent.
    let shown = after_prefix(inner.as_deref().unwrap_or(sent)).and_then(|n| digits(&n));
    shown.or_else(|| inner.as_deref().and_then(digits))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_words_as_check_input_does() {
        let words = check_words(&json!({"title": "  Oak  ", "labels": [" a", "a", "b"], "notes": null, "position": 2})).unwrap();
        assert_eq!(words.title.as_deref(), Some("Oak"));
        assert_eq!(words.labels, Some(vec!["a".to_string(), "b".to_string()]));
        assert_eq!(words.notes, Some(None));
        assert_eq!(words.position, Some(2.0));
        assert_eq!(check_words(&json!({"github_issues": [12, " o/n#3 "]})).unwrap().github_issues, Some(vec!["12".to_string(), "o/n#3".to_string()]));
        let refused = check_words(&json!({"status": 3, "title": "", "model": "gpt", "effort": "huge", "position": null})).unwrap_err();
        assert_eq!(refused.message, "5 problems in the body");
        assert_eq!(check_words(&json!({"proposal": null})).unwrap().proposal, Some(None));
        assert_eq!(check_words(&json!({"proposal": "pending"})).unwrap().proposal, Some(Some("pending".to_string())));
        assert!(check_words(&json!({"proposal": "changes"})).is_err());
        assert!(check_words(&json!({"github_issues": [0]})).is_err() && check_words(&json!({"labels": ["", "a"]})).is_err());
        assert!(check_words(&json!([])).is_err());
        assert_eq!(check_words(&json!({"epic": 3})).unwrap().epic, Some(Some("3".to_string())));
        assert_eq!(check_words(&json!({"epic": " EPC-3 "})).unwrap().epic, Some(Some("EPC-3".to_string())));
        assert_eq!(check_words(&json!({"epic": null})).unwrap().epic, Some(None));
        assert!(check_words(&json!({"epic": 1.5})).is_err() && check_words(&json!({"epic": " "})).is_err() && check_words(&json!({"epic": true})).is_err());
    }

    #[test]
    fn finds_an_epics_number_as_number_of_does() {
        let uid = "x7k2m9qd";
        for (sent, number) in [("14", Some("14")), ("EPC-14", Some("14")), ("epc-14", Some("14")), ("EPC-14-x7k2m9qd", Some("14"))] {
            assert_eq!(epic_number(sent, uid).as_deref(), number, "{sent}");
        }
        for sent in ["EPC-14-aaaaaaaa", "Launch", "EPC-", "MLS-14", "épc-1"] {
            assert_eq!(epic_number(sent, uid), None, "{sent}");
        }
    }
}
