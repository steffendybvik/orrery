// The owner's decision on a proposal (ORR-927): `decide` in web/server/store/bulk.ts. Approving commits it, into Todo
// while it's in the backlog; asking for changes can name an option to go further down; a rejection is said to the
// session on it but starts no work (`Handoff::quiet`). Either way it goes back to whoever proposed it, and the decision
// is left on it as the owner's comment.
use crate::board::choices::{describe_picks, resolve_picks, stored, Picks};
use crate::board::comments::Handoff;
use crate::board::issue_writes::IssueWrites;
use crate::board::issues::Issues;
use crate::changes;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::{js, stamp, Actor};
use serde_json::{json, Map, Value};
use sqlx::Row;

/// What a decision takes (`DECISION_FIELDS`), in its order.
const FIELDS: [&str; 4] = ["decision", "note", "picks", "explore"];
/// The decisions (`DECISIONS`).
const DECISIONS: [&str; 3] = ["approved", "changes", "rejected"];

/// The comment a decision leaves (`DECIDED`).
fn decided(decision: &str) -> &'static str {
    match decision {
        "approved" => "Approved this proposal.",
        "changes" => "Asked for changes to this proposal.",
        _ => "Rejected this proposal.",
    }
}

/// A decision's body, as `checkInput(body, DECISION_FIELDS)` takes it.
struct Sent {
    decision: String,
    note: Option<String>,
    picks: Option<Picks>,
    explore: Option<(String, String)>,
}

fn check(body: &Value) -> Result<Sent> {
    // None sent is none at all (`body ?? {}`).
    let empty = Value::Object(Map::new());
    let body = if body.is_null() { &empty } else { body };
    let Some(object) = body.as_object() else { return Err(ApiError::bad_request("The body should be a JSON object")) };
    let mut problems = vec![];
    for key in object.keys() {
        if !FIELDS.contains(&key.as_str()) {
            problems.push(format!("unknown field \"{key}\"; this takes {}", FIELDS.join(", ")));
        }
    }
    let decision = match object.get("decision") {
        None => {
            problems.push("missing \"decision\"".into());
            None
        }
        Some(Value::Null) => {
            problems.push("\"decision\" can't be null".into());
            None
        }
        Some(Value::String(d)) if DECISIONS.contains(&d.as_str()) => Some(d.clone()),
        Some(Value::String(d)) => {
            problems.push(format!("\"decision\" is \"{d}\", not one of {}", DECISIONS.join(", ")));
            None
        }
        Some(other) => {
            problems.push(format!("\"decision\" should be a string, not {}", js(other)));
            None
        }
    };
    let note = match object.get("note") {
        None | Some(Value::Null) => None,
        Some(Value::String(n)) => Some(n.clone()),
        Some(other) => {
            problems.push(format!("\"note\" should be a string, not {}", js(other)));
            None
        }
    };
    let picks = match object.get("picks") {
        None => None,
        Some(Value::Null) => {
            problems.push("\"picks\" can't be null".into());
            None
        }
        Some(Value::Object(picks)) => match picks.iter().find(|(_, p)| !p.as_array().is_some_and(|l| l.iter().all(Value::is_string))) {
            Some((key, _)) => {
                problems.push(format!("\"picks\": {key} should be a list of option keys"));
                None
            }
            None => Some(picks.clone()),
        },
        Some(_) => {
            problems.push("\"picks\": should be {choice: [options]}".into());
            None
        }
    };
    let explore = match object.get("explore") {
        None => None,
        Some(Value::Null) => {
            problems.push("\"explore\" can't be null".into());
            None
        }
        Some(Value::Object(e)) => match (e.get("choice").and_then(Value::as_str), e.get("option").and_then(Value::as_str)) {
            (Some(choice), Some(option)) => Some((choice.to_string(), option.to_string())),
            _ => {
                problems.push("\"explore\": should be {choice, option}".into());
                None
            }
        },
        Some(_) => {
            problems.push("\"explore\": should be {choice, option}".into());
            None
        }
    };
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    Ok(Sent { decision: decision.unwrap_or_default(), note, picks, explore })
}

/// The 403 for anyone but the owner, as `ownerOnly(actor, 'proposals.decide')` words it.
pub fn owner_only(actor: &Actor) -> Result<()> {
    if actor.owner {
        return Ok(());
    }
    let why = "A proposal asks the owner; deciding it is their answer.";
    let message = if actor.untrusted {
        format!("Approve, reject or ask for changes to a proposal: refused for an untrusted session (proposals.decide). {why}")
    } else {
        format!("Approve, reject or ask for changes to a proposal: owner only for a session (proposals.decide). {why} Send Orrery-Actor: <owner>")
    };
    Err(ApiError::refused_for("proposals.decide", message))
}

impl IssueWrites<'_> {
    /// One proposal's part of a decision on many (`decideIssues`): an approval needs a recommendation for each choice
    /// that isn't down another's option, so nothing is approved on a guess.
    pub async fn decide_one_of_many(&mut self, project: &str, sent: &str, decision: &Value, actor: &Actor) -> Result<(String, Handoff, bool)> {
        let id = self.issue_id(project, sent).await?;
        self.issue_there(project, &id).await?;
        let row = sqlx::query(&sql("SELECT choices FROM issues WHERE project = ? AND id = ?")).bind(project).bind(&id).fetch_one(&mut *self.conn).await?;
        let unsure: Vec<String> = stored(&row.get::<Option<String>, _>("choices").unwrap_or_default())
            .into_iter()
            .filter(|c| c.from.is_none() && c.recommended.is_empty())
            .map(|c| format!("\"{}\"", c.question))
            .collect();
        if decision.get("decision").and_then(Value::as_str) == Some("approved") && !unsure.is_empty() {
            return Err(ApiError::bad_request(format!("Needs your picks: nothing is recommended for {}", unsure.join(", "))));
        }
        self.decide(project, sent, decision, actor).await
    }

    /// The owner's decision on the proposal (`decide`). Gives back its id, the comment's `Handoff`, and whether approving
    /// made it urgent open work, for the Nuxt server to pass on, as only it reaches the sessions.
    pub async fn decide(&mut self, project: &str, sent: &str, body: &Value, actor: &Actor) -> Result<(String, Handoff, bool)> {
        let id = self.issue_id(project, sent).await?;
        self.issue_there(project, &id).await?;
        let row = sqlx::query(&sql(
            "SELECT status, assignee, proposal, CAST(owned AS BIGINT) AS owned, created_by, created_person, choices FROM issues WHERE project = ? AND id = ?",
        ))
        .bind(project)
        .bind(&id)
        .fetch_one(&mut *self.conn)
        .await?;
        let status: String = row.get("status");
        let held: Option<String> = row.get("assignee");
        let proposal: Option<String> = row.get("proposal");
        let owned = row.get::<Option<i64>, _>("owned").unwrap_or_default() != 0;
        let created_by: Option<String> = row.get("created_by");
        let created_person: Option<String> = row.get("created_person");
        let choices_text: String = row.get::<Option<String>, _>("choices").unwrap_or_else(|| "[]".into());
        owner_only(actor)?;
        let Some(proposal) = proposal else {
            return Err(ApiError::bad_request(format!("{id} isn't a proposal; make it one with PATCH {{\"proposal\": \"pending\"}}")));
        };
        let input = check(body)?;
        let decision = input.decision.as_str();
        let note = input.note.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(String::from);
        // With people, the person whose agent proposed it.
        let assignee = if owned {
            held.clone()
        } else {
            let shared: i64 =
                sqlx::query("SELECT CAST(count(*) AS BIGINT) AS n FROM people WHERE removed_at IS NULL").fetch_one(&mut *self.conn).await?.get("n");
            match created_person.filter(|p| shared > 1 && !p.is_empty()) {
                Some(person) => Some(person),
                None => created_by,
            }
        };
        let choices = stored(&choices_text);
        if input.picks.is_some() && (decision != "approved" || choices.is_empty()) {
            return Err(ApiError::bad_request("\"picks\" go with approving a proposal that has choices"));
        }
        if input.explore.is_some() && decision != "changes" {
            return Err(ApiError::bad_request("\"explore\" goes with asking for changes"));
        }
        let picks = if decision == "approved" && !choices.is_empty() {
            Some(
                resolve_picks(&choices, &input.picks.clone().unwrap_or_default())
                    .map_err(|e| ApiError::bad_request(format!("Can't approve {id} with those picks: {e}")))?,
            )
        } else {
            None
        };
        let explored = match &input.explore {
            Some((choice, option)) => match choices.iter().find(|c| c.key == *choice).and_then(|c| c.options.iter().find(|o| o.key == *option)) {
                Some(o) => Some((o.key.clone(), o.title.clone())),
                None => return Err(ApiError::bad_request(format!("{id} has no option {option} in a choice \"{choice}\""))),
            },
            None => None,
        };
        let explore = input.explore.as_ref().map(|(choice, option)| json!({"choice": choice, "option": option}).to_string());
        let picks_text = picks.as_ref().map(|p| Value::Object(p.clone()).to_string());
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql(
                "UPDATE issues SET proposal = ?, decided_by = ?, decided_at = ?, decision_note = ?, assignee = ?, picks = ?, explore = ? WHERE project = ? AND id = ?",
            ))
            .bind(decision)
            .bind(&actor.name)
            .bind(stamp())
            .bind(note.as_deref())
            .bind(assignee.as_deref())
            .bind(picks_text.as_deref())
            .bind(explore.as_deref())
            .bind(project)
            .bind(&id)
            .execute(&mut *self.conn)
            .await?;
            if proposal != decision {
                self.record_field(project, &id, actor, "proposal", Some(&proposal), Some(decision)).await?;
            }
            if held != assignee {
                self.record_field(project, &id, actor, "assignee", held.as_deref(), assignee.as_deref()).await?;
            }
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        let said = match (&picks, &explored) {
            (Some(picks), _) => format!("Approved this proposal with:\n{}", describe_picks(&choices, picks)),
            (None, Some((key, title))) => {
                format!("Asked to explore {key} ({title}) further: add a choice that goes down it, then put the proposal up again.")
            }
            _ => decided(decision).to_string(),
        };
        let text = match &note {
            Some(note) => format!("{said}\n\n{note}"),
            None => said,
        };
        let (_, mut handoff) = self.create(project, &id, &json!({"body": text}), actor).await?;
        // Approving, or asking for changes, is work; a rejection is said to the session but starts none (ORR-606).
        handoff.quiet = decision == "rejected";
        let mut urgent = false;
        // Approving is the owner saying it's work: into Todo while it's still in the backlog, else where its work took it.
        if decision == "approved" {
            let statuses = Issues::new(&mut *self.conn).statuses().await?;
            let waiting = statuses.iter().find(|s| s.id == status).is_some_and(|s| s.kind == "backlog");
            let mut edit = Map::new();
            edit.insert("proposal".into(), Value::Null);
            if waiting {
                edit.insert("status".into(), json!("todo"));
            }
            // Its own write, as the store's `updateIssue` is: it says the project changed again in the outbox.
            let said = std::mem::take(&mut self.effects);
            if self.outbox.is_some() {
                self.outbox = Some(changes::Outbox::new(actor.clone()));
            }
            let edited = self.edit_words(project, &id, &Value::Object(edit), actor).await;
            let more = std::mem::replace(&mut self.effects, said);
            urgent = edited?.is_some();
            self.effects.told.extend(more.told);
            for changed in more.changed {
                if !self.effects.changed.contains(&changed) {
                    self.effects.changed.push(changed);
                }
            }
        }
        Ok((id, handoff, urgent))
    }
}
