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
use crate::issues::{github_issue_of, github_repo, GITHUB_OWN};
use regex::Regex;
use serde_json::Value;
use sqlx::Row;
use std::sync::LazyLock;

/// The fields this takes, in the order `ISSUE_FIELDS` has them, which is the order its problems are listed in.
pub const WORDS: [&str; 8] = ["title", "labels", "external", "github_issues", "notes", "model", "effort", "position"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(best|opus|sonnet|haiku|fable|default|opusplan|claude-[a-z0-9.-]{1,56}(\[1m\])?)$").unwrap());
const MODEL_HINT: &str = "use best, opus, sonnet, haiku, fable, default, opusplan or a full id such as claude-sonnet-5-5";

/// What an edit sets: each `None` when it isn't sent, and `Some(None)` for one sent as null.
#[derive(Debug, Default, PartialEq)]
pub struct Words {
    pub title: Option<String>,
    pub labels: Option<Vec<String>>,
    pub external: Option<Vec<String>>,
    pub github_issues: Option<Vec<String>>,
    pub notes: Option<Option<String>>,
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
    /// that isn't its person's, unless it's its own proposal.
    pub async fn edit_words(&mut self, project: &str, sent: &str, body: &Value, actor: &Actor) -> Result<()> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let words = check_words(body)?;
        let row = sqlx::query(&sql(
            "SELECT title, labels, external, github_issues, notes, model, effort, assignee, proposal, created_person FROM issues WHERE project = ? AND id = ?",
        ))
        .bind(project)
        .bind(&issue)
        .fetch_one(&mut *self.conn)
        .await?;
        let row = Before {
            title: row.get("title"),
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
        let linked = self.linked_projects(project, &issue).await?;
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let changed: [Change; 7] = [
                ("title", Some(row.title.as_str()), words.title.as_deref().map(Some)),
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
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = std::iter::once(project.to_string()).chain(linked.into_iter().filter(|p| p != project)).collect();
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        Ok(())
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
