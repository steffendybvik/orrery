// The chat's and an untrusted session's new issues, rewritten in the API (ORR-1059), sent straight to it with no Nuxt in
// front, and the session a new issue is noted as worked by.
use super::*;
use crate::testing::{Req, TestApi};
use serde_json::json;

fn chat(req: Req) -> Req {
    req.by_agent("claude").header("orrery-actor-asked", "1").header("orrery-actor-kind", "chat")
}

#[test]
fn the_chat_keeps_a_proposal_and_drops_its_status_plan_and_assignee() {
    let headers = HeaderMap::new();
    let made = as_chat_issue(json!({"title": "A", "status": "done", "plan": "now", "assignee": "steffen", "priority": "P1"}), &headers);
    assert_eq!(made, json!({"title": "A", "status": "todo", "priority": "P1"}));
    let proposal = as_chat_issue(json!({"title": "B", "status": "done", "proposal": "pending"}), &headers);
    assert_eq!(proposal, json!({"title": "B", "proposal": "pending"}));
    assert_eq!(as_chat_issue(json!("not an issue"), &headers), json!("not an issue"));
}

#[test]
fn the_chat_lands_in_backlog_only_when_the_owner_picked_it() {
    let mut headers = HeaderMap::new();
    headers.insert("orrery-chat-issues", "backlog".parse().unwrap());
    assert_eq!(as_chat_issue(json!({"title": "A"}), &headers)["status"], "backlog");
    headers.insert("orrery-chat-issues", "done".parse().unwrap());
    assert_eq!(as_chat_issue(json!({"title": "A"}), &headers)["status"], "todo");
}

#[test]
fn an_untrusted_ask_keeps_its_words_alone() {
    let sent = json!({"title": "T", "notes": "N", "choices": [{"label": "x"}], "github_issues": [3], "priority": "P0", "parent": "ORR-1", "assignee": "steffen", "labels": ["bug"]});
    assert_eq!(
        as_proposal(&sent),
        json!({"title": "T", "notes": "N", "choices": [{"label": "x"}], "github_issues": [3], "proposal": "pending", "labels": ["external"]})
    );
    assert_eq!(as_proposal(&json!(null)), json!({"proposal": "pending", "labels": ["external"]}));
}

#[test]
fn worked_by_is_never_the_chats() {
    let mut headers = HeaderMap::new();
    assert_eq!(worked_by(&headers, false), None);
    headers.insert("orrery-worked-by", "abc%20d".parse().unwrap());
    assert_eq!(worked_by(&headers, false).as_deref(), Some("abc d"));
    assert_eq!(worked_by(&headers, true), None);
}

#[tokio::test]
async fn the_chats_issue_is_made_with_nobody_on_it_in_its_status() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let at = format!("/api/projects/{project}/issues");
    let made = chat(api.post(&at, json!({"title": "Sieve", "status": "in-progress", "assignee": "owner"}))).send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    assert_eq!((&made.body["status"], &made.body["assignee"]), (&json!("todo"), &json!(null)), "{}", made.body);
    let backlog = chat(api.post(&at, json!({"title": "Later"}))).header("orrery-chat-issues", "backlog").send().await;
    assert_eq!(backlog.body["status"], "backlog", "{}", backlog.body);
    let proposal = chat(api.post(&at, json!({"title": "Maybe", "status": "done", "proposal": "pending"}))).send().await;
    assert_eq!(proposal.body["proposal"], "pending", "{}", proposal.body);
    assert_ne!(proposal.body["status"], "done", "the chat's status is dropped from a proposal too: {}", proposal.body);
}

#[tokio::test]
async fn an_untrusted_sessions_issue_is_made_an_external_proposal() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let made = api
        .post(&format!("/api/projects/{project}/issues"), json!({"title": "From outside", "priority": "P0", "labels": ["urgent"], "status": "in-progress"}))
        .untrusted()
        .send()
        .await;
    assert_eq!(made.status, 201, "{}", made.body);
    assert_eq!(made.body["proposal"], "pending", "{}", made.body);
    assert_eq!(made.body["labels"], json!(["external"]), "{}", made.body);
    assert_eq!(made.body["priority"], json!(null), "{}", made.body);
    assert!(made.header("orrery-urgent").is_none(), "an outsider's ask is never pushed as urgent");
}

#[tokio::test]
async fn a_sessions_new_issue_is_noted_as_its_work_but_not_the_chats() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let at = format!("/api/projects/{project}/issues");
    let made = api.post(&at, json!({"title": "Sieve"})).agent_of_nobody().header("orrery-worked-by", "s-1").send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    let id = made.body["id"].as_str().unwrap();
    let noted = format!("SELECT count(*) FROM issue_sessions WHERE project = '{project}' AND issue = '{id}' AND session = 's-1'");
    assert_eq!(api.count(&noted).await, 1);
    let chats = chat(api.post(&at, json!({"title": "For others"}))).header("orrery-worked-by", "s-2").send().await;
    assert_eq!(chats.status, 201, "{}", chats.body);
    assert_eq!(api.count("SELECT count(*) FROM issue_sessions WHERE session = 's-2'").await, 0);
}
