use super::*;

#[test]
fn github_issues() {
    assert_eq!(github_repo(Some(" https://github.com/ada/shop.git ")).as_deref(), Some("ada/shop"));
    assert_eq!(github_repo(Some("https://gitlab.com/ada/shop")), None);
    assert_eq!(github_issue_of("523", Some("ada/shop")).as_deref(), Some("ada/shop#523"));
    assert_eq!(github_issue_of("#07", Some("ada/shop")).as_deref(), Some("ada/shop#7"));
    assert_eq!(github_issue_of("https://github.com/ada/shop/issues/9", None).as_deref(), Some("ada/shop#9"));
    assert_eq!(github_issue_of("ada/shop#0", None), None);
    assert_eq!(github_issue_of("523", None), None);
}

#[test]
fn ids() {
    assert_eq!(short_id("ORR-12-x7k2m3qd", &[""], "x7k2m3qd").as_deref(), Some("ORR-12"));
    assert_eq!(short_id("MLS-3-x7k2m3qd", &["MLS-", "chk-"], "x7k2m3qd").as_deref(), Some("3"));
    assert_eq!(short_id("mls-3-x7k2m3qd", &["MLS-", "chk-"], "x7k2m3qd").as_deref(), Some("3"));
    assert_eq!(short_id("chk-3-x7k2m3qd", &["MLS-", "chk-"], "x7k2m3qd").as_deref(), Some("3"));
    assert_eq!(short_id("3-x7k2m3qd", &["MLS-", "chk-"], "x7k2m3qd"), None);
    assert_eq!(shown_number("MLS-14").as_deref(), Some("14"));
    assert_eq!(shown_number("mls-14").as_deref(), Some("14"));
    assert_eq!(shown_number("MLS-"), None);
    assert_eq!(shown_number("MLS-1a"), None);
}

#[test]
fn statuses() {
    let statuses = [("backlog", "backlog"), ("todo", "todo"), ("in-progress", "started"), ("review", "started")]
        .map(|(id, kind)| Status { id: id.into(), kind: kind.into() });
    assert_eq!(status_ids(&statuses, "started, todo,review"), ["in-progress", "review", "todo"]);
    assert_eq!(status_ids(&statuses, "doing"), ["in-progress", "review"]);
    assert!(status_ids(&statuses, "proposed").is_empty());
}
/// Each issue reads the same alone (ORR-1117) as it does found on the whole board: sub-issues and their roll-up,
/// proposals and what's under one, open questions, links either way, risks and aliases.
#[tokio::test]
async fn one_issue_reads_as_the_whole_board_has_it() {
    use crate::testing::TestApi;
    let api = TestApi::new().await;
    let (project, other) = (api.project("Primes").await, api.project("Sieve").await);
    let issues = format!("/api/projects/{project}/issues");
    let made = |reply: crate::testing::Reply| reply.body["id"].as_str().unwrap().to_string();
    let milestone = api.post(&format!("/api/projects/{project}/milestones"), json!({"title": "First"})).send().await.body["id"].as_str().unwrap().to_string();
    let top = api.issue(&project, json!({"title": "Top", "milestone": milestone})).await;
    let sub = api.issue(&project, json!({"title": "Sub", "parent": top, "status": "in-progress"})).await;
    let deep = api.issue(&project, json!({"title": "Deep", "parent": sub, "status": "done"})).await;
    let elsewhere = api.issue(&other, json!({"title": "Over there"})).await;
    let blocked = api.issue(&project, json!({"title": "Blocked", "depends_on": [top, format!("{other}/{elsewhere}")]})).await;
    let proposal = made(api.post(&issues, json!({"title": "Idea", "proposal": "pending"})).by_agent("claude").send().await);
    let under = made(api.post(&issues, json!({"title": "Part", "parent": proposal, "proposal": "pending"})).by_agent("claude").send().await);
    let asked = api.issue(&project, json!({"title": "Asked"})).await;
    let comments = format!("{issues}/{asked}/comments");
    api.post(&comments, json!({"body": "Which?", "asks": "decision"})).by_agent("claude").send().await;
    api.post(&format!("{issues}/{sub}/comments"), json!({"body": "Noted"})).send().await;
    api.run("INSERT INTO issue_aliases (project, alias, issue) VALUES (?, 'OLD-1', ?)", &[&project, &sub]).await;
    api.run(
        "INSERT INTO issue_pulls (project, issue, repo, number, title, url, branch, base, author, state, created_at, updated_at, risk, risk_why, risk_by) \
             VALUES (?, ?, 'a/b', 7, 't', 'u', 'b', 'main', 'me', 'open', '2026-11-01', '2026-11-01', 'high', 'why', 'owner')",
        &[&project, &deep],
    )
    .await;

    let mut conn = api.app.pool.acquire().await.unwrap();
    let mut read = Issues::new(&mut conn);
    let statuses = read.statuses(&project).await.unwrap();
    let board = read.board(&project, &statuses).await.unwrap();
    for id in [&top, &sub, &deep, &blocked, &proposal, &under, &asked] {
        let alone = read.subtree(&project, id, &statuses).await.unwrap();
        match (board.find(id), alone) {
            (Some((node, parent, milestone)), Some((issue, place))) => {
                assert_eq!(issue.json(), node.json(), "{id}");
                assert_eq!((place.parent, place.milestone), (parent, milestone), "{id}");
            }
            (None, None) => {}
            (on_board, alone) => panic!("{id}: on the board {}, alone {}", on_board.is_some(), alone.is_some()),
        }
    }
    let top = read.subtree(&project, &top, &statuses).await.unwrap().unwrap().0.json();
    assert_eq!(top["tasks"][0]["tasks"][0]["risk"]["level"], "high");
    assert_eq!(top["tasks"][0]["aliases"], json!(["OLD-1"]));
    assert_eq!(read.subtree(&project, &asked, &statuses).await.unwrap().unwrap().0.json()["waiting"], "decision");
    assert_eq!(read.subtree(&project, &proposal, &statuses).await.unwrap().unwrap().0.json()["tasks"][0]["column"], "proposed");
}

/// A board with a bit of everything on it, for reading parts of it as the whole has them: a milestone with sub-issues
/// and their roll-up, links either way, proposals and what's under one, an open question, a risk, an alias, labels,
/// assignees, a release, and two issues in a loop (not on the board).
async fn mixed(api: &crate::testing::TestApi) -> (String, String) {
    let (project, other) = (api.project("Primes").await, api.project("Sieve").await);
    api.patch(&format!("/api/projects/{project}"), json!({"release_mode": "own"})).send().await;
    api.post(&format!("/api/projects/{project}/releases"), json!({"version": "1.0"})).send().await;
    let issues = format!("/api/projects/{project}/issues");
    let made = |reply: crate::testing::Reply| reply.body["id"].as_str().unwrap().to_string();
    let milestone = api.post(&format!("/api/projects/{project}/milestones"), json!({"title": "First"})).send().await.body["id"].as_str().unwrap().to_string();
    let top = api.issue(&project, json!({"title": "Top", "milestone": milestone, "labels": ["ui"], "release": "1.0"})).await;
    let sub = api.issue(&project, json!({"title": "Sub", "parent": top, "status": "in-progress", "assignee": "claude", "priority": "P0"})).await;
    let deep = api.issue(&project, json!({"title": "Deep", "parent": sub, "status": "done", "labels": ["ui", "api"]})).await;
    api.issue(&project, json!({"title": "Second", "milestone": milestone, "status": "todo", "release": "1.0"})).await;
    let elsewhere = api.issue(&other, json!({"title": "Over there"})).await;
    api.issue(&project, json!({"title": "Blocked", "depends_on": [top, format!("{other}/{elsewhere}")], "external": ["T-1"]})).await;
    api.issue(&project, json!({"title": "Free", "depends_on": [deep], "release": "1.0"})).await;
    let proposal = made(api.post(&issues, json!({"title": "Idea", "proposal": "pending"})).by_agent("claude").send().await);
    let under = made(api.post(&issues, json!({"title": "Part", "parent": proposal, "proposal": "pending"})).by_agent("claude").send().await);
    api.issue(&project, json!({"title": "Below", "parent": under, "release": "1.0"})).await;
    let asked = api.issue(&project, json!({"title": "Asked", "github_issues": ["a/b#5"]})).await;
    api.post(&format!("{issues}/{asked}/comments"), json!({"body": "Which?", "asks": "decision"})).by_agent("claude").send().await;
    api.run("INSERT INTO issue_aliases (project, alias, issue) VALUES (?, 'OLD-1', ?)", &[&project, &sub]).await;
    api.run(
        "INSERT INTO issue_pulls (project, issue, repo, number, title, url, branch, base, author, state, created_at, updated_at, risk, risk_why, risk_by) \
             VALUES (?, ?, 'a/b', 7, 't', 'u', 'b', 'main', 'me', 'open', '2026-11-01', '2026-11-01', 'high', 'why', 'owner')",
        &[&project, &deep],
    )
    .await;
    let (a, b) = (api.issue(&project, json!({"title": "Loop A"})).await, api.issue(&project, json!({"title": "Loop B"})).await);
    api.run("UPDATE issues SET parent = ? WHERE project = ? AND id = ?", &[&b, &project, &a]).await;
    api.run("UPDATE issues SET parent = ? WHERE project = ? AND id = ?", &[&a, &project, &b]).await;
    (project, milestone)
}

/// The list (ORR-1118) filters on the wide outline as it would on the whole board, and builds those listed alone as
/// the whole board has them.
#[tokio::test]
async fn the_list_reads_as_the_whole_board_has_it() {
    use crate::testing::TestApi;
    let api = TestApi::new().await;
    let (project, milestone) = mixed(&api).await;
    let mut conn = api.app.pool.acquire().await.unwrap();
    let mut read = Issues::new(&mut conn);
    let statuses = read.statuses(&project).await.unwrap();

    let whole: HashMap<String, Map<String, Value>> =
        read.board(&project, &statuses).await.unwrap().records(&project).into_iter().map(|r| (id_or_title(&r).0, r)).collect();
    let sketched = read.sketch(&project, &statuses, Some(&WIDE.map(|(_, column)| column))).await.unwrap().records(&project);
    assert_eq!(sketched.len(), whole.len());
    for sketch in &sketched {
        let full = &whole[&id_or_title(sketch).0];
        for (key, value) in sketch {
            assert_eq!(full.get(key), Some(value), "{key} of {}", id_or_title(sketch).0);
        }
    }

    let filters: &[&[(&str, &str)]] = &[
        &[],
        &[("status", "todo")],
        &[("status", "started,done")],
        &[("column", "in-progress")],
        &[("column", "proposed")],
        &[("priority", "P0")],
        &[("priority", "none")],
        &[("assignee", "claude")],
        &[("assignee", "none")],
        &[("label", "ui")],
        &[("external", "T-1")],
        &[("github_issue", "a/b#5")],
        &[("milestone", &milestone)],
        &[("milestone", "none")],
        &[("release", "1.0")],
        &[("release", "none")],
        &[("parent", "none")],
        &[("proposal", "pending")],
        &[("proposal", "none")],
        &[("blocked", "true")],
        &[("blocked", "false")],
        &[("q", "deep")],
        &[("q", "which"), ("in", "all")],
        &[("label", "ui"), ("status", "done")],
    ];
    for filter in filters {
        let filter: HashMap<String, String> = filter.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let alone = read.listing(&project, &filter, Some(false)).await.unwrap();
        let from_whole = read.listing(&project, &filter, Some(true)).await.unwrap();
        assert_eq!(alone.to_string(), from_whole.to_string(), "{filter:?}");
        assert_eq!(read.list(&project, &filter).await.unwrap(), alone, "{filter:?}");
    }
    let listed = |filter: &[(&str, &str)]| {
        let filter: HashMap<String, String> = filter.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        filter
    };
    let blocked = read.listing(&project, &listed(&[("blocked", "true")]), Some(false)).await.unwrap();
    assert_eq!(blocked.as_array().unwrap().iter().map(|r| r["title"].as_str().unwrap()).collect::<Vec<_>>(), ["Blocked"]);
    let ui = read.listing(&project, &listed(&[("label", "ui")]), Some(false)).await.unwrap();
    assert_eq!(ui[0]["kinds"]["done"], 1, "a listed issue's roll-up counts the leaves under it");
}

/// A milestone and a release (ORR-1118), read with only their own issues built, as the whole board has them.
#[tokio::test]
async fn a_milestone_and_a_release_read_as_the_whole_board_has_them() {
    use crate::testing::TestApi;
    let api = TestApi::new().await;
    let (project, milestone) = mixed(&api).await;
    let whole = api.get(&format!("/api/projects/{project}")).send().await.body;
    let group = whole["board"]["milestones"].as_array().unwrap().iter().find(|g| g["id"] == milestone.as_str()).unwrap().clone();
    let one = api.get(&format!("/api/projects/{project}/milestones/{milestone}")).send().await.body;
    for key in ["tasks", "column", "kind", "counts", "kinds", "title", "aliases"] {
        assert_eq!(one[key].to_string(), group[key].to_string(), "{key}");
    }
    assert_eq!(one["tasks"][0]["tasks"][0]["tasks"][0]["risk"]["level"], "high");

    fn walk(out: &mut Vec<Value>, issues: &Value) {
        for issue in issues.as_array().into_iter().flatten() {
            if issue["release"] == "1.0" {
                out.push(issue.clone());
            } else {
                walk(out, &issue["tasks"]);
            }
        }
    }
    let mut set = Vec::new();
    for group in whole["board"]["milestones"].as_array().unwrap() {
        walk(&mut set, &group["tasks"]);
    }
    let release = api.get(&format!("/api/projects/{project}/releases/1.0")).send().await.body;
    assert_eq!(release["tasks"].to_string(), Value::Array(set).to_string());
    assert_eq!(release["tasks"].as_array().unwrap().len(), 4, "Top, Second, Free and the one under a proposal");
    let listed = whole["releases"].as_array().unwrap().iter().find(|r| r["version"] == "1.0").unwrap();
    assert_eq!((&release["issues"], &release["kinds"]), (&listed["issues"], &listed["kinds"]));
}

/// Building several issues at once (ORR-1118), one inside another and one under a proposal, gives each as the
/// whole board has it.
#[tokio::test]
async fn issues_built_together_read_as_the_whole_board_has_them() {
    use crate::testing::TestApi;
    let api = TestApi::new().await;
    let (project, _) = mixed(&api).await;
    let mut conn = api.app.pool.acquire().await.unwrap();
    let mut read = Issues::new(&mut conn);
    let statuses = read.statuses(&project).await.unwrap();
    let board = read.board(&project, &statuses).await.unwrap();
    let ids: Vec<String> = board.records(&project).iter().map(|r| id_or_title(r).0).collect();
    for chosen in [ids.clone(), ids.iter().rev().step_by(2).cloned().collect(), ids[1..3].to_vec()] {
        let built = read.nodes(&project, &statuses, &chosen).await.unwrap();
        assert_eq!(built.len(), chosen.len());
        for id in &chosen {
            assert_eq!(built[id].json(), board.find(id).unwrap().0.json(), "{id}");
        }
    }
}
