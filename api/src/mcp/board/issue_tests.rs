// The tests of the `issue` tool at `/mcp` (issue.rs), through `router()` on a database of their own.
use crate::testing::TestApi;
use serde_json::{json, Value};

async fn issue(api: &TestApi, args: Value) -> Value {
    let reply = api.post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "issue", "arguments": args}})).send().await;
    let said = reply.body["result"]["content"][0]["text"].as_str().unwrap_or_else(|| panic!("a text answer: {}", reply.body));
    serde_json::from_str(said).unwrap_or_else(|_| panic!("JSON: {said}"))
}

async fn comment(api: &TestApi, project: &str, id: &str, body: Value) {
    let reply = api.post(&format!("/api/projects/{project}/issues/{id}/comments"), body).by_agent("claude").send().await;
    assert_eq!(reply.status, 201, "commenting: {}", reply.body);
}

#[tokio::test]
async fn an_issue_comes_with_its_open_sub_issues_and_the_finished_ones_counted() {
    let api = TestApi::new().await;
    let (project, id) = api.board().await;
    api.issue(&project, json!({"title": "Wheel", "parent": id})).await;
    for title in ["Segmented", "Bitset"] {
        let sub = api.issue(&project, json!({"title": title, "parent": id})).await;
        api.patch(&format!("/api/projects/{project}/issues/{sub}"), json!({"status": "done"})).send().await;
    }
    let said = issue(&api, json!({"id": id})).await;
    assert_eq!(said["id"], id.as_str());
    assert_eq!(said["title"], "Sieve");
    assert_eq!(said["sub_issues"], json!(["PRI-2 [backlog] Wheel"]));
    assert_eq!(said["finished_sub_issues"], "2 done");
    for gone in ["tasks", "counts", "kinds", "pull_requests", "branches", "older_comments"] {
        assert!(said.get(gone).is_none(), "{gone} in {said}");
    }
    let keys: Vec<&String> = said.as_object().unwrap().keys().collect();
    // As the channel's spread: the comments take the place of the issue's count of them, and what's added comes last.
    let at = |k: &str| keys.iter().position(|x| *x == k).unwrap();
    assert!(at("comments") < at("created_at") && keys.ends_with(&[&"sub_issues".to_string(), &"finished_sub_issues".to_string()]), "{keys:?}");
}

#[tokio::test]
async fn only_the_latest_comments_and_unanswered_asks_are_in_full() {
    let api = TestApi::new().await;
    let (project, id) = api.board().await;
    comment(&api, &project, &id, json!({"body": "\n  Which way?  \nMore", "asks": "decision"})).await;
    comment(&api, &project, &id, json!({"body": format!("{}\nrest", "x".repeat(200))})).await;
    for n in 1..=5 {
        comment(&api, &project, &id, json!({"body": format!("Note {n}")})).await;
    }
    let said = issue(&api, json!({"id": id})).await;
    let comments = said["comments"].as_array().unwrap();
    assert_eq!(comments.len(), 7);
    assert_eq!(comments[0]["asks"], "decision", "an unanswered ask stays in full");
    assert_eq!(comments[0]["body"], "\n  Which way?  \nMore");
    assert_eq!(comments[1]["first_line"], format!("{}…", "x".repeat(139)));
    assert!(comments[1].get("body").is_none());
    assert_eq!(comments[6]["body"], "Note 5");
    assert!(comments[6].get("asks").is_none());
    assert_eq!(said["older_comments"], "1 shown by their first line: comments: \"all\" gives them in full");

    let all = issue(&api, json!({"id": id, "comments": "all"})).await;
    assert!(all["comments"].as_array().unwrap().iter().all(|c| c.get("body").is_some()));
    assert!(all.get("older_comments").is_none());
}

#[tokio::test]
async fn its_pull_requests_are_the_polls_while_it_stands_and_whats_kept_after() {
    let api = TestApi::new().await;
    let (project, id) = api.board().await;
    api.run("UPDATE projects SET repo = 'https://github.com/ada/primes'", &[]).await;
    let kept = |number: i64, merged: bool, author: &str| {
        json!({
            "projects": [project], "names": [id], "title": "Sieve", "url": format!("https://github.com/ada/primes/pull/{number}"),
            "branch": "feat/pri-1", "base": "main", "author": author, "merged": merged, "closed": false,
            "merged_at": if merged { json!("2026-11-03T10:00:00Z") } else { Value::Null },
            "created_at": "2026-11-01T10:00:00Z", "updated_at": format!("2026-11-0{number}T10:00:00Z"),
        })
    };
    for (number, merged, author) in [(3, true, "ada"), (5, false, "not a login!")] {
        let reply = api.put(&format!("/api/pulls/ada/primes/{number}"), kept(number, merged, author)).send().await;
        assert_eq!(reply.status, 204, "{}", reply.body);
    }

    // No poll that stands: the open one as kept, without where it stands.
    let said = issue(&api, json!({"id": id})).await;
    assert_eq!(
        said["pull_requests"],
        json!([
            {"number": 5, "state": "open", "base": "main", "url": "https://github.com/ada/primes/pull/5"},
            {"number": 3, "state": "merged", "base": "main", "url": "https://github.com/ada/primes/pull/3", "merged_at": "2026-11-03T10:00:00Z", "author": "ada"},
        ])
    );

    // A poll with a token just now: the open one as it read it.
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let polled = json!({
        "number": 5, "names": [id], "title": "Sieve", "url": "https://github.com/ada/primes/pull/5", "branch": "feat/pri-1",
        "base": "main", "author": "ada", "draft": false, "head_sha": "abc", "state": "ready", "review": null, "review_id": null,
        "checks": "passing", "merged": false, "closed": false, "merge_sha": null, "closed_by": null,
        "created_at": "2026-11-01T10:00:00Z", "updated_at": "2026-11-05T10:00:00Z", "told": [],
    });
    let reply = api.put("/api/pulls/ada/primes", json!({"at": now, "token": true, "more": false, "pulls": [polled]})).send().await;
    assert_eq!(reply.status, 204, "{}", reply.body);
    let said = issue(&api, json!({"id": id})).await;
    assert_eq!(
        said["pull_requests"][0],
        json!({"number": 5, "state": "ready", "base": "main", "url": "https://github.com/ada/primes/pull/5", "author": "ada"})
    );
    assert_eq!(said["pull_requests"][1]["number"], 3);
    assert_eq!(said["pull_requests"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn an_approved_proposals_choices_are_what_was_picked() {
    let api = TestApi::new().await;
    let (project, id) = api.board().await;
    let choices = json!([
        {"key": "how", "question": "How?", "options": [{"key": "a", "title": "Fast"}, {"key": "b", "title": "Small"}]},
        {"key": "when", "question": "When?", "options": [{"key": "now", "title": "Now"}]},
    ]);
    api.run(
        "UPDATE issues SET choices = ?, picks = ?, decided_by = 'steffen' WHERE id = ?",
        &[&choices.to_string(), &json!({"how": ["b", "gone"]}).to_string(), &id],
    )
    .await;
    let said = issue(&api, json!({"id": id})).await;
    assert_eq!(said["picks"], json!([{"question": "How?", "picked": ["Small", "gone"]}]), "{said}");
    assert!(said.get("choices").is_none());
    assert_eq!(said["choices_left_out"], "comments: \"all\" gives every option");
    let all = issue(&api, json!({"id": id, "comments": "all"})).await;
    assert_eq!(all["choices"], choices);
    let _ = project;
}

#[tokio::test]
async fn an_issue_that_isnt_there_is_refused_in_the_channels_words() {
    let api = TestApi::new().await;
    api.board().await;
    let reply =
        api.post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "issue", "arguments": {"id": "PRI-99"}}})).send().await;
    assert_eq!(reply.body["result"]["isError"], true, "{}", reply.body);
    assert!(reply.body["result"]["content"][0]["text"].as_str().unwrap().starts_with("orrery said no:"), "{}", reply.body);
}
