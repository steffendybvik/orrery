// The `issue` tool at `/mcp` (ORR-1101), as channel/tools.mjs answers it: the issue, its open sub-issues (the finished
// ones counted), its pull requests and its comments, the latest and unanswered asks in full and the others by their
// first line, so a long issue stays small in a session's context (ORR-547).
//
// Its pull requests are what the API keeps (`Pulls::for_issue`): the Nuxt server asks GitHub when the poll's read is
// stale, and that's the machine's work. Its branches are git on this machine, so they stay in the channel's answer.
use super::{line, text, truthy, Api, Said};
use crate::work::pulls::Pulls;
use axum::http::Method;
use serde_json::{json, Map, Value};

/// How many of the latest comments `issue` gives in full, as the channel's `LATEST_COMMENTS`.
const LATEST_COMMENTS: usize = 5;

impl Api<'_> {
    pub(super) async fn issue(&self, args: &Value) -> Said {
        let id = args.get("id").map(text).unwrap_or_else(|| "undefined".into());
        let project = self.project_of_issue(&json!({"id": id})).await?;
        let path = self.issue_path(&project, &id);
        let issue = self.call(Method::GET, &path, None).await?;
        let comments = self.list(&format!("{path}/comments")).await?;
        // As the channel's `.catch(() => null)`: none when they can't be read.
        let pulls = match self.app.pool.acquire().await {
            Ok(mut conn) => Pulls::new(&mut conn).for_issue(&text(&issue["project"]), &text(&issue["id"])).await.unwrap_or_default(),
            Err(_) => vec![],
        };

        let mut rest: Map<String, Value> = issue.as_object().cloned().unwrap_or_default();
        let tasks = rest.shift_remove("tasks").and_then(|t| t.as_array().cloned()).unwrap_or_default();
        rest.shift_remove("counts");
        rest.shift_remove("kinds");
        let finished = |t: &Value| t["kind"] == "done" || t["kind"] == "canceled";
        // Counted by status, in the order each first comes (`Object.groupBy`).
        let mut counted: Vec<(String, usize)> = vec![];
        for task in tasks.iter().filter(|t| finished(t)) {
            let status = text(&task["status"]);
            match counted.iter_mut().find(|(s, _)| *s == status) {
                Some((_, n)) => *n += 1,
                None => counted.push((status, 1)),
            }
        }

        let all = args["comments"] == "all";
        let picked = if all { None } else { picked_of(&rest) };
        if let Some(picked) = &picked {
            rest.shift_remove("choices");
            rest.insert("picks".into(), picked.clone());
        }

        let latest = comments.len().saturating_sub(LATEST_COMMENTS);
        let said: Vec<Value> = comments
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut comment = Map::new();
                comment.insert("by".into(), c["created_by"].clone());
                comment.insert("at".into(), c["created_at"].clone());
                if all || i >= latest || (truthy(&c["asks"]) && !truthy(&c["answered"])) {
                    if truthy(&c["asks"]) {
                        comment.insert("asks".into(), c["asks"].clone());
                        if let Some(answered) = c.get("answered") {
                            comment.insert("answered".into(), answered.clone());
                        }
                    }
                    comment.insert("body".into(), c["body"].clone());
                } else {
                    comment.insert("first_line".into(), json!(first_line(&text(&c["body"]))));
                }
                Value::Object(comment)
            })
            .collect();
        let older = said.iter().filter(|c| c.get("first_line").is_some()).count();

        let mut answer = rest;
        answer.insert("sub_issues".into(), json!(tasks.iter().filter(|t| !finished(t)).map(line).collect::<Vec<_>>()));
        if !counted.is_empty() {
            let counted: Vec<String> = counted.iter().map(|(status, n)| format!("{n} {status}")).collect();
            answer.insert("finished_sub_issues".into(), json!(counted.join(", ")));
        }
        if !pulls.is_empty() {
            answer.insert("pull_requests".into(), json!(pulls));
        }
        answer.insert("comments".into(), json!(said));
        if older > 0 {
            answer.insert("older_comments".into(), json!(format!("{older} shown by their first line: comments: \"all\" gives them in full")));
        }
        if picked.is_some() {
            answer.insert("choices_left_out".into(), json!("comments: \"all\" gives every option"));
        }
        Ok(Value::Object(answer).to_string())
    }
}

/// A comment's first line that says something, cut to a line's length (140 UTF-16 units, as the channel's `firstLine`).
fn first_line(body: &str) -> String {
    let first = body.split('\n').map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let units: Vec<u16> = first.encode_utf16().collect();
    if units.len() > 140 {
        format!("{}…", String::from_utf16_lossy(&units[..139]))
    } else {
        first.to_string()
    }
}

/// An approved proposal's choices as what still matters, each question with the titles picked (ORR-643), as the
/// channel's `pickedOf`: none for a pending proposal, or one sent back or rejected.
fn picked_of(issue: &Map<String, Value>) -> Option<Value> {
    let field = |k: &str| issue.get(k).cloned().unwrap_or(Value::Null);
    let (picks, choices) = (field("picks"), field("choices"));
    let has_choices = choices.as_array().is_some_and(|c| !c.is_empty());
    if !truthy(&field("decided_by")) || truthy(&field("proposal")) || !truthy(&picks) || !has_choices {
        return None;
    }
    let picked = choices
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let keys = picks.get(text(&c["key"]))?.as_array().filter(|k| !k.is_empty())?;
            let options = c["options"].as_array().cloned().unwrap_or_default();
            let titles: Vec<Value> = keys
                .iter()
                .map(|key| options.iter().find(|o| o["key"] == *key).map(|o| o["title"].clone()).filter(|t| !t.is_null()).unwrap_or_else(|| key.clone()))
                .collect();
            Some(json!({"question": c["question"], "picked": titles}))
        })
        .collect();
    Some(Value::Array(picked))
}

#[cfg(test)]
#[path = "issue_tests.rs"]
mod tests;
