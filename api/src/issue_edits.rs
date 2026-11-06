// Changing an issue's own words (ORR-927): the part of `updateIssue` in web/server/store/issues.ts that changes what an
// issue says and where it sits among its siblings, and nothing that moves it on the board: `title`, `notes`, `labels`,
// its tasks (`external`), its GitHub issues, the `model` and `effort` a session for it starts on, and its `position`.
// The router sends a `PATCH …/issues/{issue}` here only when it names none of the other fields (`wordsOnly`), so its
// status, assignee, proposal, parent, milestone, release, epic, priority (a P0's push), links and moving it stay the
// Nuxt server's for now. The rails are the store's: an agent changes only its person's issue, or its own proposal.
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
pub const WORDS: [&str; 10] = ["title", "priority", "labels", "external", "github_issues", "notes", "depends_on", "model", "effort", "position"];
/// The most issues one can depend on (`MAX_DEPENDS`).
const MAX_DEPENDS: usize = 50;
const PRIORITIES: [&str; 4] = ["P0", "P1", "P2", "P3"];
/// The kinds of status an issue is closed in (`CLOSED`).
const CLOSED: [&str; 2] = ["done", "canceled"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(best|opus|sonnet|haiku|fable|default|opusplan|claude-[a-z0-9.-]{1,56}(\[1m\])?)$").unwrap());
const MODEL_HINT: &str = "use best, opus, sonnet, haiku, fable, default, opusplan or a full id such as claude-sonnet-5-5";

/// What an edit sets: each `None` when it isn't sent, and `Some(None)` for one sent as null.
#[derive(Debug, Default, PartialEq)]
pub struct Words {
    pub title: Option<String>,
    pub priority: Option<Option<String>>,
    pub labels: Option<Vec<String>>,
    pub external: Option<Vec<String>>,
    pub github_issues: Option<Vec<String>>,
    pub notes: Option<Option<String>>,
    /// What it depends on, all of it (ORR-601): `Some(vec![])` for none.
    pub depends_on: Option<Vec<String>>,
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
    let Some(object) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
    let mut problems = vec![];
    for key in object.keys() {
        if !WORDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", WORDS.join(", ")));
        }
    }
    let mut words = Words::default();
    for key in WORDS {
        let Some(value) = object.get(key) else { continue };
        let nullable = !matches!(key, "title" | "position");
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
}

impl Comments<'_> {
    /// Changes the issue's own words (`updateIssue`, for `WORDS` only), noting each changed field in its activity and
    /// telling it, without a title's or a link's words, as an outsider may have written them. 409 for an agent on one
    /// that isn't its person's, unless it's its own proposal. Gives back the issue's id when the edit made it urgent open
    /// work it wasn't (P0, `urgent`), for the Nuxt server to push to the sessions, as only it reaches them.
    pub async fn edit_words(&mut self, project: &str, sent: &str, body: &Value, actor: &Actor) -> Result<Option<String>> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let words = check_words(body)?;
        let row = sqlx::query(&sql(
            "SELECT title, status, priority, labels, external, github_issues, notes, model, effort, assignee, proposal, created_person FROM issues WHERE project = ? AND id = ?",
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
        };
        if let Some(rails) = self.rails_for(actor).await? {
            // An agent's own proposal is its to edit and put up again, though it waits on the owner.
            let own_proposal = rails.is_some() && row.proposal.is_some() && row.created_person == rails;
            if !own_proposal {
                self.must_hold(rails.as_deref(), &issue, row.assignee.as_deref(), "change it").await?;
            }
        }
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
            let changed: [Change; 8] = [
                ("title", Some(row.title.as_str()), words.title.as_deref().map(Some)),
                ("priority", row.priority.as_deref(), words.priority.as_ref().map(Option::as_deref)),
                ("labels", row.labels.as_deref(), labels.as_deref().map(Some)),
                ("external", row.external.as_deref(), external.as_deref().map(Some)),
                ("github_issues", row.github_issues.as_deref(), github.as_deref().map(Some)),
                ("notes", row.notes.as_deref(), words.notes.as_ref().map(Option::as_deref)),
                ("model", row.model.as_deref(), words.model.as_ref().map(Option::as_deref)),
                ("effort", row.effort.as_deref(), words.effort.as_ref().map(Option::as_deref)),
            ];
            let mut set: Vec<(&str, Option<String>)> = vec![];
            for (field, before, after) in changed {
                let Some(after) = after else { continue };
                set.push((field, after.map(Into::into)));
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
            let mut columns: Vec<String> = set.iter().map(|(field, _)| format!("{field} = ?")).collect();
            if words.position.is_some() {
                columns.push("position = ?".into());
            }
            columns.push("updated_at = ?".into());
            let query = sql(&format!("UPDATE issues SET {} WHERE project = ? AND id = ?", columns.join(", ")));
            let mut update = sqlx::query(&query);
            for (_, value) in &set {
                update = update.bind(value.clone());
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
        let made_p0 = words.priority.as_ref().is_some_and(|p| p.as_deref() == Some("P0")) && row.priority.as_deref() != Some("P0");
        if !made_p0 || !(actor.owner || actor.person.is_some()) || row.proposal.is_some() {
            return Ok(None);
        }
        let statuses = Issues::new(&mut *self.conn).statuses().await?;
        let closed = statuses.iter().any(|s| s.id == row.status && CLOSED.contains(&s.kind.as_str()));
        Ok((!closed).then_some(issue))
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
        let refused = check_words(&json!({"status": "todo", "title": "", "model": "gpt", "effort": "huge", "position": null})).unwrap_err();
        assert_eq!(refused.message, "5 problems in the body");
        assert!(check_words(&json!({"github_issues": [0]})).is_err() && check_words(&json!({"labels": ["", "a"]})).is_err());
        assert!(check_words(&json!([])).is_err());
    }
}
