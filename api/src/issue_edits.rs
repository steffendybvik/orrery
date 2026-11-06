// Changing an issue's own words (ORR-927): the part of `updateIssue` in web/server/store/issues.ts that changes what an
// issue says, where it sits among its siblings and what it's under, and nothing that moves it on the board: `title`,
// `priority`, `notes`, `labels`, its tasks (`external`), its GitHub issues, its `parent`, `milestone` and `release`, the
// `model` and `effort` a session for it starts on, and its `position`. The router sends a `PATCH …/issues/{issue}` here
// only when it names none of the other fields (`wordsOnly`), so its status, assignee, proposal, epic, links and moving
// it to another project stay the Nuxt server's for now. The rails are the store's: an agent changes only its person's
// issue, or its own proposal, and moves one only under an issue that's its person's too.
use crate::changes;
use crate::comments::Comments;
use crate::db::sql;
use crate::docs::{js, stamp, Actor};
use crate::error::{ApiError, Result};
use crate::issues::{github_issue_of, github_repo, Issues, GITHUB_OWN};
use regex::Regex;
use serde_json::Value;
use sqlx::Row;
use std::sync::LazyLock;

/// The fields this takes, in the order `ISSUE_FIELDS` has them, which is the order its problems are listed in.
pub const WORDS: [&str; 12] =
    ["title", "priority", "labels", "external", "github_issues", "notes", "parent", "milestone", "release", "model", "effort", "position"];
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
    pub parent: Option<Option<String>>,
    pub milestone: Option<Option<String>>,
    pub release: Option<Option<String>>,
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
            "labels" | "external" if value.is_null() => *if key == "labels" { &mut words.labels } else { &mut words.external } = Some(vec![]),
            "labels" => words.labels = strings(key, value, &mut problems),
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
            "parent" => words.parent = text(key, value, &mut problems, |_| None),
            "milestone" => words.milestone = text(key, value, &mut problems, |_| None),
            "release" => words.release = text(key, value, &mut problems, |_| None),
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
            "SELECT title, status, priority, labels, external, github_issues, notes, model, effort, assignee, proposal, created_person, parent, milestone, ships_in FROM issues WHERE project = ? AND id = ?",
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
        };
        // While it waits on the owner, it isn't work yet: which release it ships in is theirs to say.
        if words.release.is_some() && !actor.owner && matches!(row.proposal.as_deref(), Some("pending" | "changes")) {
            let settings = crate::settings::Settings::new(&mut *self.conn).get().await?;
            if settings["restrict_proposals"].as_bool().unwrap_or(true) {
                return Err(ApiError::refused_for(
                    "issues.edit",
                    format!("{issue} is a proposal waiting on the owner, so its release isn't yours to change until they approve it"),
                ));
            }
        }
        let place = self.placement(project, &issue, &words, &row).await?;
        if let Some(rails) = self.rails_for(actor).await? {
            // An agent's own proposal is its to edit and put up again, though it waits on the owner.
            let own_proposal = rails.is_some() && row.proposal.is_some() && row.created_person == rails;
            if !own_proposal {
                self.must_hold(rails.as_deref(), &issue, row.assignee.as_deref(), "change it").await?;
            }
            if named(&place.parent) && place.parent != row.parent {
                let parent = place.parent.as_deref().unwrap_or_default();
                let assignee = self.assignee_of(project, parent).await?;
                self.must_hold(rails.as_deref(), parent, assignee.as_deref(), "move an issue under it").await?;
            }
        }
        let github = match &words.github_issues {
            Some(sent) => Some(self.github_issues_of(project, sent).await?),
            None => None,
        };
        let listed = |list: &Option<Vec<String>>| list.as_ref().map(|l| serde_json::to_string(l).unwrap_or_default());
        let (labels, external, github) = (listed(&words.labels), listed(&words.external), listed(&github));
        let linked = self.linked_projects(project, &issue).await?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            // A sub-issue is in its parent's milestone, so a new parent says it all.
            let placed: Change = if place.moved {
                ("parent", row.parent.as_deref(), Some(place.parent.as_deref()))
            } else {
                ("milestone", row.milestone.as_deref(), place.milestone.as_ref().map(Option::as_deref))
            };
            let changed: [Change; 10] = [
                ("title", Some(row.title.as_str()), words.title.as_deref().map(Some)),
                ("priority", row.priority.as_deref(), words.priority.as_ref().map(Option::as_deref)),
                ("labels", row.labels.as_deref(), labels.as_deref().map(Some)),
                ("external", row.external.as_deref(), external.as_deref().map(Some)),
                ("github_issues", row.github_issues.as_deref(), github.as_deref().map(Some)),
                ("notes", row.notes.as_deref(), words.notes.as_ref().map(Option::as_deref)),
                placed,
                ("release", row.ships_in.as_deref(), place.release.as_ref().map(Option::as_deref)),
                ("model", row.model.as_deref(), words.model.as_ref().map(Option::as_deref)),
                ("effort", row.effort.as_deref(), words.effort.as_ref().map(Option::as_deref)),
            ];
            let mut set: Vec<(&str, Option<String>)> = vec![];
            for (field, before, after) in changed {
                let Some(after) = after else { continue };
                // The release an issue ships in is kept as `ships_in`, and a milestone is written whether or not the
                // new parent is noted in its place; a parent only when the edit sends one.
                if !matches!(field, "parent" | "milestone" | "release") {
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
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = std::iter::once(project.to_string()).chain(linked.into_iter().filter(|p| p != project)).collect();
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let made_p0 = words.priority.as_ref().is_some_and(|p| p.as_deref() == Some("P0")) && row.priority.as_deref() != Some("P0");
        if !made_p0 || !(actor.owner || actor.person.is_some()) || row.proposal.is_some() {
            return Ok(None);
        }
        let statuses = Issues::new(&mut *self.conn).statuses().await?;
        let closed = statuses.iter().any(|s| s.id == row.status && CLOSED.contains(&s.kind.as_str()));
        Ok((!closed).then_some(issue))
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
