// The tests of routes/notices.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};

/// An agent's comment on the issue, `asks` a decision or feedback or none; gives back its id.
async fn agent_says(api: &TestApi, project: &str, issue: &str, body: &str, asks: Option<&str>) -> i64 {
    let mut sent = json!({"body": body});
    if let Some(asks) = asks {
        sent["asks"] = json!(asks);
    }
    let reply = api.post(&format!("/api/projects/{project}/issues/{issue}/comments"), sent).by_agent("claude").send().await;
    assert_eq!(reply.status, 201, "an agent's comment: {}", reply.body);
    reply.body["id"].as_i64().unwrap()
}

async fn owner_says(api: &TestApi, project: &str, issue: &str, body: &str) -> i64 {
    let reply = api.post(&format!("/api/projects/{project}/issues/{issue}/comments"), json!({"body": body})).send().await;
    assert_eq!(reply.status, 201, "the owner's comment: {}", reply.body);
    reply.body["id"].as_i64().unwrap()
}

async fn bell(api: &TestApi, query: &str) -> Value {
    let reply = api.get(&format!("/api/notices{query}")).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.body
}

fn bodies(notices: &Value) -> Vec<&str> {
    notices.as_array().unwrap().iter().map(|n| n["body"].as_str().unwrap_or_default()).collect()
}

/// A project with an issue on it.
async fn board(api: &TestApi) -> (String, String) {
    let project = api.project("Primes").await;
    let issue = api.issue(&project, json!({"title": "Sieve"})).await;
    (project, issue)
}

/// The owner and a member, Ana, so each has a bell of their own.
async fn two_people(api: &TestApi) {
    sqlx::query("INSERT INTO people (id, name, role, created_at) VALUES ('owner', 'Owner', 'owner', '2026-01-01'), ('ana', 'Ana', 'member', '2026-01-01')")
        .execute(&api.app.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_bell_is_empty_at_first() {
    let api = TestApi::new().await;
    assert_eq!(bell(&api, "").await, json!([]));
}

#[tokio::test]
async fn an_agents_comment_rings_the_bell_and_the_owners_own_doesnt() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let id = agent_says(&api, &project, &issue, "Done the sieve", None).await;
    owner_says(&api, &project, &issue, "Thanks").await;
    let notices = bell(&api, "").await;
    assert_eq!(bodies(&notices), ["Done the sieve"]);
    let notice = &notices[0];
    assert_eq!(notice["id"], id);
    assert_eq!(notice["project"], json!(project));
    assert_eq!(notice["issue"], json!(issue));
    assert_eq!(notice["title"], "Sieve");
    assert_eq!(notice["created_by"], "claude");
    assert!(notice.get("cleared").is_none() && notice.get("read").is_none(), "{notice}");
}

#[tokio::test]
async fn what_waits_on_the_owner_comes_first_until_they_answer() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let other = api.issue(&project, json!({"title": "Wheel"})).await;
    agent_says(&api, &project, &issue, "Which sieve?", Some("decision")).await;
    agent_says(&api, &project, &other, "Later news", None).await;
    assert_eq!(bodies(&bell(&api, "").await), ["Which sieve?", "Later news"]);
    assert_eq!(bodies(&bell(&api, "?list=waiting").await), ["Which sieve?"]);
    assert_eq!(bodies(&bell(&api, "?list=inbox").await), ["Later news"]);
    owner_says(&api, &project, &issue, "Eratosthenes").await;
    assert_eq!(bodies(&bell(&api, "").await), ["Later news", "Which sieve?"], "answered, it's in date order");
    assert_eq!(bell(&api, "?list=waiting").await, json!([]));
    assert_eq!(bodies(&bell(&api, "?list=inbox").await), ["Later news", "Which sieve?"]);
}

#[tokio::test]
async fn the_bell_holds_the_latest_thirty() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    for n in 0..32 {
        agent_says(&api, &project, &issue, &format!("note {n}"), None).await;
    }
    let notices = bell(&api, "").await;
    assert_eq!(notices.as_array().unwrap().len(), 30);
    assert_eq!(notices[0]["body"], "note 31");
}

#[tokio::test]
async fn the_inbox_is_paged_by_limit_and_before() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let mut ids = vec![];
    for n in 0..5 {
        ids.push(agent_says(&api, &project, &issue, &format!("note {n}"), None).await);
    }
    assert_eq!(bodies(&bell(&api, "?list=inbox&limit=2").await), ["note 4", "note 3"]);
    assert_eq!(bodies(&bell(&api, &format!("?list=inbox&limit=2&before={}", ids[3])).await), ["note 2", "note 1"]);
    assert_eq!(bell(&api, "?list=inbox&limit=0").await.as_array().unwrap().len(), 5, "a limit of 0 is none: the default");
}

#[tokio::test]
async fn a_list_it_doesnt_know_is_refused() {
    let api = TestApi::new().await;
    let reply = api.get("/api/notices?list=archive").send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.body["message"], "Unknown list \"archive\"; use bell, waiting, inbox, cleared");
}

#[tokio::test]
async fn an_agents_proposal_waits_on_the_owner_ahead_of_everything() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    agent_says(&api, &project, &issue, "Which sieve?", Some("decision")).await;
    let reply = api
        .post(&format!("/api/projects/{project}/issues"), json!({"title": "Use a wheel", "notes": "Faster", "proposal": "pending"}))
        .by_agent("claude")
        .send()
        .await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let proposal = reply.body["id"].as_str().unwrap().to_string();
    let notices = bell(&api, "").await;
    assert_eq!(notices.as_array().unwrap().len(), 2);
    let first = &notices[0];
    assert_eq!(first["id"], 0, "a proposal isn't a comment");
    assert_eq!(first["issue"], json!(proposal));
    assert_eq!(first["title"], "Use a wheel");
    assert_eq!(first["body"], "Faster");
    assert_eq!(first["asks"], "decision");
    assert_eq!(first["proposal"], json!({"choices": 0}));
    assert_eq!(notices[1]["body"], "Which sieve?");
    assert!(bell(&api, "?list=waiting").await.as_array().unwrap().iter().any(|n| n["issue"] == json!(proposal)));
    assert!(bell(&api, "?list=inbox").await.as_array().unwrap().iter().all(|n| n["id"] != 0), "the inbox has no proposals");
}

#[tokio::test]
async fn clearing_by_id_takes_a_comment_out_of_the_bell_into_cleared() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let one = agent_says(&api, &project, &issue, "One", None).await;
    agent_says(&api, &project, &issue, "Two", None).await;
    let reply = api.post("/api/notices/clear", json!({"ids": [one, 99999]})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!({"cleared": 1}));
    assert_eq!(bodies(&bell(&api, "").await), ["Two"]);
    let cleared = bell(&api, "?list=cleared").await;
    assert_eq!(bodies(&cleared), ["One"]);
    assert_eq!(cleared[0]["cleared"], true);
    let again = api.post("/api/notices/clear", json!({"ids": [one]})).send().await;
    assert_eq!(again.body, json!({"cleared": 0}), "a cleared one isn't cleared twice");
    let comments = api.get(&format!("/api/projects/{project}/issues/{issue}/comments")).send().await;
    assert!(comments.body.to_string().contains("\"One\""), "the comment stays on its issue");
}

#[tokio::test]
async fn the_owners_own_comment_cant_be_cleared() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let own = owner_says(&api, &project, &issue, "Mine").await;
    assert_eq!(api.post("/api/notices/clear", json!({"ids": [own]})).send().await.body, json!({"cleared": 0}));
}

#[tokio::test]
async fn clearing_a_proposal_keeps_it_pending_and_out_of_the_bell() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let reply = api.post(&format!("/api/projects/{project}/issues"), json!({"title": "Use a wheel", "proposal": "pending"})).by_agent("claude").send().await;
    let proposal = reply.body["id"].as_str().unwrap().to_string();
    let cleared =
        api.post("/api/notices/clear", json!({"proposals": [{"project": project, "issue": proposal}, {"project": project, "issue": "PRI-404"}]})).send().await;
    assert_eq!(cleared.body, json!({"cleared": 1}), "only one waiting is cleared");
    assert_eq!(bell(&api, "").await, json!([]));
    let gone = bell(&api, "?list=cleared").await;
    assert_eq!(gone[0]["issue"], json!(proposal));
    assert_eq!(gone[0]["cleared"], true);
    let issue = api.get(&format!("/api/projects/{project}/issues/{proposal}")).send().await;
    assert_eq!(issue.body["proposal"], "pending");
}

#[tokio::test]
async fn clearing_before_a_time_leaves_what_still_waits_on_the_owner() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let other = api.issue(&project, json!({"title": "Wheel"})).await;
    agent_says(&api, &project, &issue, "News", None).await;
    agent_says(&api, &project, &other, "Which?", Some("feedback")).await;
    let reply = api.post("/api/notices/clear", json!({"before": "2999-01-01T00:00:00.000Z"})).send().await;
    assert_eq!(reply.body, json!({"cleared": 1}));
    assert_eq!(bodies(&bell(&api, "").await), ["Which?"]);
    let none = api.post("/api/notices/clear", json!({"before": "2000-01-01T00:00:00.000Z"})).send().await;
    assert_eq!(none.body, json!({"cleared": 0}), "nothing that old");
}

#[tokio::test]
async fn marking_read_shows_on_the_notice_and_clearing_read_takes_those() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let one = agent_says(&api, &project, &issue, "One", None).await;
    agent_says(&api, &project, &issue, "Two", None).await;
    let reply = api.post("/api/notices/read", json!({"ids": [one]})).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, json!({"read": 1}));
    let notices = bell(&api, "").await;
    assert_eq!(notices[1]["read"], true);
    assert!(notices[0].get("read").is_none());
    assert_eq!(notices.as_array().unwrap().len(), 2, "reading leaves the bell alone");
    assert_eq!(api.post("/api/notices/read", json!({"ids": [one]})).send().await.body, json!({"read": 0}));
    assert_eq!(api.post("/api/notices/clear", json!({"read": true})).send().await.body, json!({"cleared": 1}));
    assert_eq!(bodies(&bell(&api, "").await), ["Two"]);
}

#[tokio::test]
async fn clearing_needs_something_to_clear() {
    let api = TestApi::new().await;
    for body in [json!({}), json!({"ids": []}), json!({"read": false}), json!({"before": ""}), json!({"ids": ["a"]}), Value::Null] {
        let reply = api.post("/api/notices/clear", body.clone()).send().await;
        assert_eq!(reply.status, 400, "{body}");
        assert_eq!(reply.body["message"], "Send \"ids\" (comment ids), \"proposals\" ([{project, issue}]), \"before\" (a time) or \"read\": true to clear");
    }
}

#[tokio::test]
async fn marking_read_needs_ids() {
    let api = TestApi::new().await;
    for body in [json!({}), json!({"ids": []}), json!({"ids": [1.5]}), json!({"ids": 3})] {
        let reply = api.post("/api/notices/read", body.clone()).send().await;
        assert_eq!(reply.status, 400, "{body}");
        assert_eq!(reply.body["message"], "Send \"ids\" (comment ids) to mark read");
    }
}

#[tokio::test]
async fn a_session_cant_clear_the_bell_or_mark_it_read() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let one = agent_says(&api, &project, &issue, "One", None).await;
    for path in ["/api/notices/clear", "/api/notices/read"] {
        let reply = api.post(path, json!({"ids": [one]})).by_agent("claude").send().await;
        assert_eq!(reply.status, 403, "{path}");
        assert_eq!(reply.body["data"]["permission"], "notices.clear");
        assert!(reply.body["message"].as_str().unwrap().contains("owner only for a session"), "{}", reply.body);
    }
    let notice = &bell(&api, "").await[0];
    assert!(notice.get("read").is_none(), "nothing changed: {notice}");
}

#[tokio::test]
async fn the_chat_and_an_untrusted_session_cant_clear_the_bell_even_naming_the_owner() {
    let api = TestApi::new().await;
    let chat = api.post("/api/notices/clear", json!({"read": true})).header("orrery-actor-kind", "chat").without("orrery-actor-owner").send().await;
    assert_eq!(chat.status, 403);
    assert!(chat.body["message"].as_str().unwrap().contains("refused for the owner's chat"), "{}", chat.body);
    let untrusted = api.post("/api/notices/read", json!({"ids": [1]})).header("orrery-actor-kind", "untrusted").send().await;
    assert_eq!(untrusted.status, 403, "the kind wins over the owner flag");
    assert!(untrusted.body["message"].as_str().unwrap().contains("refused for an untrusted session"), "{}", untrusted.body);
}

#[tokio::test]
async fn status_changes_on_the_issues_in_the_bell_are_listed_oldest_first() {
    let api = TestApi::new().await;
    let (project, issue) = board(&api).await;
    let quiet = api.issue(&project, json!({"title": "Quiet"})).await;
    agent_says(&api, &project, &issue, "Starting", None).await;
    for status in ["in-progress", "done"] {
        let reply = api.patch(&format!("/api/projects/{project}/issues/{issue}"), json!({"status": status})).send().await;
        assert_eq!(reply.status, 200, "{}", reply.body);
    }
    api.patch(&format!("/api/projects/{project}/issues/{quiet}"), json!({"status": "done"})).send().await;
    let reply = api.get("/api/notices/changes?since=2000-01-01").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let changes = reply.body.as_array().unwrap();
    assert_eq!(changes.len(), 2, "only the issue the bell has a comment on: {}", reply.body);
    assert_eq!((changes[0]["issue"].as_str(), changes[0]["after"].as_str()), (Some(issue.as_str()), Some("in-progress")));
    assert_eq!(changes[1]["before"], "in-progress");
    assert_eq!(changes[1]["after"], "done");
    assert_eq!(changes[1]["project"], json!(project));
    assert!(changes[0]["id"].is_i64() && changes[0]["created_at"].is_string());
    let later = api.get("/api/notices/changes?since=2999-01-01T00:00:00Z").send().await;
    assert_eq!(later.body, json!([]));
}

#[tokio::test]
async fn status_changes_need_a_time_since() {
    let api = TestApi::new().await;
    for query in ["", "?since=", "?since=yesterday"] {
        let reply = api.get(&format!("/api/notices/changes{query}")).send().await;
        assert_eq!(reply.status, 400, "{query}");
        assert_eq!(reply.body["message"], "Send \"since\", a time");
    }
}

#[tokio::test]
async fn a_members_bell_is_their_own_and_has_no_proposals() {
    let api = TestApi::new().await;
    two_people(&api).await;
    let (project, issue) = board(&api).await;
    let mine: i64 = sqlx::query_scalar(&format!(
        "INSERT INTO comments (project, issue, body, created_by, owned, person, by_agent, created_at, updated_at) VALUES ('{project}', '{issue}', 'For Ana', 'ana-agent', 0, 'ana', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z') RETURNING id"
    ))
    .fetch_one(&api.app.pool)
    .await
    .unwrap();
    api.post(&format!("/api/projects/{project}/issues"), json!({"title": "Use a wheel", "proposal": "pending"})).by_agent("claude").send().await;
    let ana = |req: crate::testing::Req| req.header("orrery-who", "browser").header("orrery-who-person", "ana").header("orrery-who-owner", "0");
    let hers = ana(api.get("/api/notices")).send().await;
    assert_eq!(hers.status, 200, "{}", hers.body);
    assert_eq!(bodies(&hers.body), ["For Ana"], "hers, and no proposal");
    assert!(!bodies(&bell(&api, "").await).contains(&"For Ana"), "not the owner's");
    let cleared = api.post("/api/notices/clear", json!({"ids": [mine]})).by_agent("ana-agent").header("orrery-actor-person", "ana").send().await;
    assert_eq!(cleared.status, 200, "a member clears their own: {}", cleared.body);
    assert_eq!(cleared.body, json!({"cleared": 1}));
    assert_eq!(ana(api.get("/api/notices")).send().await.body, json!([]));
    let flag: i64 = sqlx::query_scalar(&crate::db::sql("SELECT cleared FROM comments WHERE id = ?")).bind(mine).fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(flag, 0, "the owner's flag on the comment stays");
    let read = api.post("/api/notices/read", json!({"ids": [mine]})).by_agent("ana-agent").header("orrery-actor-person", "ana").send().await;
    assert_eq!(read.body, json!({"read": 1}));
    let theirs: i64 = sqlx::query_scalar("SELECT count(*) FROM notice_reads WHERE person = 'ana'").fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(theirs, 1);
}
