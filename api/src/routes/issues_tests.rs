// What the issue routes do (ORR-1053), through the router as the Nuxt router in front sends them: reading issues,
// making and changing one, bulk changes and deletes, claims, decisions on proposals, comments and activity, and the
// rails between people (what an agent may change, whose issue it is, handing one on).
use crate::testing::{ids, Reply, TestApi};
use serde_json::{json, Value};

/// A project, `primes`, and the paths and reads on its issues.
struct Board<'a> {
    api: &'a TestApi,
    project: String,
}

impl Board<'_> {
    /// Project Primes, with everyone here on its board, as the board check wants of a member (ORR-1059).
    async fn new(api: &TestApi) -> Board<'_> {
        let project = api.project("Primes").await;
        api.run(
            "INSERT INTO project_members (project, person, role, created_at) SELECT ?, id, 'member', '2026-11-01' FROM people WHERE role <> 'owner'",
            &[&project],
        )
        .await;
        Board { project, api }
    }

    fn issues(&self) -> String {
        format!("/api/projects/{}/issues", self.project)
    }

    fn at(&self, issue: &str) -> String {
        format!("/api/projects/{}/issues/{issue}", self.project)
    }

    async fn issue(&self, body: Value) -> String {
        self.api.issue(&self.project, body).await
    }

    /// The issue as it reads now.
    async fn read(&self, issue: &str) -> Value {
        let reply = self.api.get(&self.at(issue)).send().await;
        assert_eq!(reply.status, 200, "reading {issue}: {}", reply.body);
        reply.body
    }

    async fn activity(&self, issue: &str) -> Vec<Value> {
        let reply = self.api.get(&format!("{}/activity", self.at(issue))).send().await;
        assert_eq!(reply.status, 200, "{}", reply.body);
        reply.body.as_array().unwrap().clone()
    }

    /// The fields its activity notes, in order.
    async fn fields_noted(&self, issue: &str) -> Vec<String> {
        self.activity(issue).await.iter().map(|e| e["field"].as_str().unwrap().to_string()).collect()
    }

    async fn comments(&self, issue: &str) -> Vec<Value> {
        let reply = self.api.get(&format!("{}/comments", self.at(issue))).send().await;
        assert_eq!(reply.status, 200, "{}", reply.body);
        reply.body.as_array().unwrap().clone()
    }

    /// An issue assigned to `person`, made and assigned by the owner.
    async fn assigned(&self, title: &str, person: &str) -> String {
        self.issue(json!({"title": title, "assignee": person})).await
    }

    /// A proposal waiting on the owner, made by an agent (with no people, so off the rails).
    async fn proposal(&self, body: Value) -> String {
        let mut body = body;
        body["proposal"] = json!("pending");
        let reply = self.api.post(&self.issues(), body).by_agent("claude").send().await;
        assert_eq!(reply.status, 201, "{}", reply.body);
        reply.body["id"].as_str().unwrap().to_string()
    }
}

fn message(reply: &Reply) -> &str {
    reply.body["message"].as_str().unwrap_or_default()
}

fn store_choice() -> Value {
    json!([{"key": "store", "question": "Which store?", "options": [{"key": "A", "title": "SQLite"}, {"key": "B", "title": "Postgres"}], "recommended": ["A"]}])
}

// Reading.

#[tokio::test]
async fn lists_a_projects_issues_with_their_refs_and_full_ids() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let first = board.issue(json!({"title": "Sieve"})).await;
    let second = board.issue(json!({"title": "Wheel"})).await;
    assert_eq!((first.as_str(), second.as_str()), ("PRI-1", "PRI-2"));
    let reply = api.get(&board.issues()).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(ids(&reply.body), ["PRI-1", "PRI-2"]);
    let listed = &reply.body[0];
    let full = board.read("PRI-1").await["full_id"].as_str().unwrap().to_string();
    assert!(full.starts_with("PRI-1-") && full.len() > 6, "{full}");
    assert_eq!(listed["full_id"], json!(full));
    assert_eq!(listed["ref"], json!("orrery-owner: PRI-1"));
    assert_eq!(listed["title"], json!("Sieve"));
}

#[tokio::test]
async fn filters_the_list_by_status_priority_assignee_label_and_words() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    board.issue(json!({"title": "Sieve of Eratosthenes", "priority": "P1", "labels": ["math"], "status": "todo"})).await;
    board.issue(json!({"title": "Wheel factorisation", "assignee": "owner", "status": "in-progress"})).await;
    board.issue(json!({"title": "Docs", "labels": ["docs"]})).await;
    let list = |query: &str| {
        let path = format!("{}?{query}", board.issues());
        let api = &api;
        async move { ids(&api.get(&path).send().await.body) }
    };
    assert_eq!(list("status=todo").await, ["PRI-1"]);
    assert_eq!(list("status=started").await, ["PRI-2"], "a kind takes every status of it");
    assert_eq!(list("priority=P1").await, ["PRI-1"]);
    assert_eq!(list("priority=none").await, ["PRI-2", "PRI-3"]);
    assert_eq!(list("assignee=owner").await, ["PRI-2"], "owner is the owner's id");
    assert_eq!(list("assignee=none").await, ["PRI-1", "PRI-3"]);
    assert_eq!(list("label=docs").await, ["PRI-3"]);
    assert_eq!(list("q=wheel").await, ["PRI-2"]);
    assert_eq!(list("q=pri-3").await, ["PRI-3"], "the id counts as words too");
    assert_eq!(list("column=backlog").await, ["PRI-3"]);
    assert_eq!(list("colour=red").await.len(), 3, "a filter it doesn't take is left out");
}

#[tokio::test]
async fn words_in_all_places_find_an_issue_by_its_description_or_a_comment_and_say_where() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    board.issue(json!({"title": "Sieve", "notes": "Uses a segmented bitmap"})).await;
    let wheel = board.issue(json!({"title": "Wheel"})).await;
    api.post(&format!("{}/comments", board.at(&wheel)), json!({"body": "Try a bitmap of odd numbers"})).send().await;
    board.issue(json!({"title": "Bitmap layout"})).await;
    let reply = api.get(&format!("{}?q=bitmap&in=all", board.issues())).send().await;
    assert_eq!(ids(&reply.body), ["PRI-3", "PRI-1", "PRI-2"], "a title match first, then the rest");
    let found = reply.body.as_array().unwrap();
    assert_eq!(found[0].get("match_in"), None);
    assert_eq!(found[1]["match_in"], json!("description"));
    assert_eq!(found[2]["match_in"], json!("comment"));
    assert!(found[2]["match"].as_str().unwrap().contains("bitmap"), "{}", found[2]);
}

#[tokio::test]
async fn reading_an_issue_rolls_its_column_and_counts_up_from_its_sub_issues() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let parent = board.issue(json!({"title": "Primes"})).await;
    board.issue(json!({"title": "Sieve", "parent": parent, "status": "in-progress"})).await;
    board.issue(json!({"title": "Wheel", "parent": parent, "status": "done"})).await;
    let read = board.read(&parent).await;
    assert_eq!(read["column"], json!("in-progress"));
    assert_eq!(read["kind"], json!("started"));
    assert_eq!(read["counts"], json!({"in-progress": 1, "done": 1}));
    assert_eq!(read["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(read["parent"], Value::Null);
    assert_eq!(board.read("PRI-2").await["parent"], json!(parent));
}

#[tokio::test]
async fn an_issue_is_found_by_its_full_id_too() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let full = board.read(&id).await["full_id"].as_str().unwrap().to_string();
    assert_eq!(board.read(&full).await["id"], json!(id));
    let reply = api.patch(&board.at(&full), json!({"priority": "P2"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["priority"], json!("P2"));
    let reply = api.post(&format!("{}/comments", board.at(&full)), json!({"body": "x"})).send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["issue"]), (201, &json!(id)));
}

#[tokio::test]
async fn an_issue_or_project_that_isnt_there_is_a_404() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    for path in [board.at("PRI-9"), format!("{}/comments", board.at("PRI-9")), format!("{}/activity", board.at("PRI-9"))] {
        let reply = api.get(&path).send().await;
        assert_eq!(reply.status, 404, "{path}: {}", reply.body);
    }
    assert_eq!(api.get("/api/projects/nowhere/issues").send().await.status, 404);
    let reply = api.patch(&board.at("PRI-9"), json!({"title": "x"})).send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (404, "No issue PRI-9 in primes"));
    assert_eq!(api.post("/api/projects/nowhere/issues", json!({"title": "x"})).send().await.status, 404);
    assert_eq!(api.delete(&board.at("PRI-9")).send().await.status, 404);
}

// Making an issue.

#[tokio::test]
async fn making_an_issue_puts_it_last_in_the_backlog_and_tells_it() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    board.issue(json!({"title": "First"})).await;
    let reply = api.post(&board.issues(), json!({"title": "  Sieve  ", "labels": ["math", "math"], "notes": "n"})).send().await;
    assert_eq!(reply.status, 201);
    let made = &reply.body;
    assert_eq!(made["id"], json!("PRI-2"));
    assert_eq!(made["title"], json!("Sieve"), "trimmed");
    assert_eq!(made["status"], json!("backlog"));
    assert_eq!(made["labels"], json!(["math"]), "each label once");
    assert_eq!(made["protected"], json!(true), "the owner's");
    assert_eq!(made["created_by"], json!("owner"));
    assert_eq!(reply.header("orrery-changed"), Some("primes"));
    assert_eq!(reply.told(), ["issue.created primes PRI-2"]);
    assert_eq!(reply.header("orrery-urgent"), None);
    assert_eq!(board.fields_noted("PRI-2").await, ["created"]);
    assert_eq!(ids(&api.get(&board.issues()).send().await.body), ["PRI-1", "PRI-2"], "last");
    // Its outbox rows went in with it.
    let rows = api.outbox().await;
    assert!(rows.iter().any(|row| row.kind == "issue.created" && row.subject.as_deref() == Some("PRI-2")), "{rows:?}");
    assert!(rows.iter().any(|row| row.kind == "project.changed"), "{rows:?}");
}

#[tokio::test]
async fn a_new_urgent_issue_is_pushed_but_not_an_urgent_proposal_or_a_closed_one() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let reply = api.post(&board.issues(), json!({"title": "Down", "priority": "P0"})).send().await;
    assert_eq!(reply.said("orrery-urgent"), ["primes PRI-1"]);
    let reply = api.post(&board.issues(), json!({"title": "Maybe", "priority": "P0", "proposal": "pending"})).send().await;
    assert_eq!(reply.header("orrery-urgent"), None);
    let reply = api.post(&board.issues(), json!({"title": "Was", "priority": "P0", "status": "done"})).send().await;
    assert_eq!(reply.header("orrery-urgent"), None);
    // An agent that names no person doesn't push its own.
    let reply = api.post(&board.issues(), json!({"title": "Agent's", "priority": "P0"})).by_agent("claude").send().await;
    assert_eq!(reply.status, 201);
    assert_eq!(reply.header("orrery-urgent"), None);
}

#[tokio::test]
async fn a_new_issue_with_a_bad_body_lists_every_problem() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let reply = api.post(&board.issues(), json!({"priority": "P9", "colour": "red", "position": "top"})).send().await;
    assert_eq!(reply.status, 400);
    let listed = reply.problems();
    assert_eq!(message(&reply), "4 problems in the body");
    assert!(listed.iter().any(|p| p.starts_with("unknown field \"colour\"")), "{listed:?}");
    assert!(listed.contains(&"missing \"title\"".to_string()), "{listed:?}");
    assert!(listed.contains(&"\"priority\" is \"P9\", not one of P0, P1, P2, P3 (or null)".to_string()), "{listed:?}");
    assert!(listed.iter().any(|p| p.starts_with("\"position\" should be a number")), "{listed:?}");
    let reply = api.post(&board.issues(), json!({"title": "   "})).send().await;
    assert_eq!((reply.status.as_u16(), reply.problems()), (400, vec!["\"title\" can't be empty".to_string()]));
    let reply = api.post(&board.issues(), json!({"title": "x", "status": "someday"})).send().await;
    assert_eq!(reply.status, 400);
    assert!(message(&reply).starts_with("\"status\" is \"someday\", not one of backlog, todo"), "{}", reply.body);
    assert!(api.get(&board.issues()).send().await.body.as_array().unwrap().is_empty(), "nothing was made");
}

#[tokio::test]
async fn a_new_issue_may_name_its_own_project_but_no_other() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "project": board.project})).send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["title"]), (201, &json!("Sieve")), "{}", reply.body);
    let reply = api.post(&board.issues(), json!({"title": "Wheel", "project": "composites"})).send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (400, "Create the issue in its project: POST /api/projects/composites/issues"));
    let reply = api.post(&board.issues(), json!({"title": "Wheel", "project": 3})).send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (400, "\"project\" should be a string, not 3"));
    // An unknown field is told with every field an issue takes, as the store told it.
    let reply = api.post(&board.issues(), json!({"title": "Wheel", "session": "s-1"})).send().await;
    assert_eq!(reply.status, 400);
    assert!(message(&reply).contains("choices, project, parent"), "{}", reply.body);
    assert_eq!(api.get(&board.issues()).send().await.body.as_array().unwrap().len(), 1, "only the first was made");
}

#[tokio::test]
async fn a_new_issue_goes_in_a_milestone_release_and_epic_there_are() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let p = &board.project;
    api.post(&format!("/api/projects/{p}/milestones"), json!({"title": "Launch"})).send().await;
    api.post("/api/epics", json!({"title": "Speed"})).send().await;
    let reply = api.post(&board.issues(), json!({"title": "x", "release": "1.0.0"})).send().await;
    assert_eq!(reply.status, 400, "no releases yet: {}", reply.body);
    api.patch(&format!("/api/projects/{p}"), json!({"release_mode": "own"})).send().await;
    let reply = api.post(&board.issues(), json!({"title": "x", "release": "1.0.0"})).send().await;
    assert_eq!(reply.status, 404, "no such release: {}", reply.body);
    api.post(&format!("/api/projects/{p}/releases"), json!({"version": "1.0.0"})).send().await;
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "milestone": "1", "release": "1.0.0", "epic": "EPC-1"})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!((&reply.body["milestone"], &reply.body["release"], &reply.body["epic"]), (&json!("1"), &json!("1.0.0"), &json!(1)));
    let reply = api.post(&board.issues(), json!({"title": "x", "milestone": "7"})).send().await;
    assert_eq!(reply.status, 404);
    let reply = api.post(&board.issues(), json!({"title": "x", "epic": 9})).send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (404, "No epic 9: GET /api/epics lists them"));
}

#[tokio::test]
async fn an_edit_moves_an_issue_to_another_release_and_epic_and_takes_them_away() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let p = &board.project;
    api.patch(&format!("/api/projects/{p}"), json!({"release_mode": "own"})).send().await;
    api.post(&format!("/api/projects/{p}/releases"), json!({"version": "1.0.0"})).send().await;
    api.post("/api/epics", json!({"title": "Speed"})).send().await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let reply = api.patch(&board.at(&id), json!({"release": "1.0.0", "epic": 1})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["release"], &reply.body["epic"]), (&json!("1.0.0"), &json!(1)));
    let events = reply.told();
    assert!(events.contains(&"issue.release primes PRI-1 ~ 1.0.0".to_string()) && events.contains(&"issue.epic primes PRI-1 ~ 1".to_string()), "{events:?}");
    let reply = api.patch(&board.at(&id), json!({"release": "2.0.0"})).send().await;
    assert_eq!(reply.status, 404);
    let reply = api.patch(&board.at(&id), json!({"release": null, "epic": null})).send().await;
    assert_eq!((reply.body.get("release"), reply.body.get("epic")), (None, None));
}

#[tokio::test]
async fn a_sub_issue_is_in_its_parents_milestone_and_cant_name_its_own() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    api.post(&format!("/api/projects/{}/milestones", board.project), json!({"title": "Launch"})).send().await;
    let parent = board.issue(json!({"title": "Primes", "milestone": "1"})).await;
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "parent": parent, "milestone": "1"})).send().await;
    assert_eq!(reply.status, 400);
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "parent": "PRI-9"})).send().await;
    assert_eq!(reply.status, 404);
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "parent": parent})).send().await;
    assert_eq!(reply.status, 201);
    assert_eq!((&reply.body["parent"], &reply.body["milestone"]), (&json!(parent), &json!("1")));
    let reply = api.post(&board.issues(), json!({"title": "Wheel", "parent": parent, "depends_on": [parent]})).send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (400, "PRI-1 is this issue's parent, so it can't depend on it"));
}

#[tokio::test]
async fn a_new_issue_can_depend_on_others_and_is_blocked_while_they_are_open() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let first = board.issue(json!({"title": "Sieve"})).await;
    let reply = api.post(&board.issues(), json!({"title": "Wheel", "depends_on": [first]})).send().await;
    assert_eq!(reply.status, 201);
    assert_eq!(reply.body["depends_on"], json!(["PRI-1"]));
    assert_eq!(reply.body["blocked_by"], json!(["PRI-1"]));
    assert_eq!(board.read(&first).await["blocks"], json!(["PRI-2"]));
    assert!(reply.told().contains(&"issue.depends primes PRI-2 ~ [\"PRI-1\"]".to_string()), "{:?}", reply.told());
    assert_eq!(ids(&api.get(&format!("{}?blocked=true", board.issues())).send().await.body), ["PRI-2"]);
    api.patch(&board.at(&first), json!({"status": "done"})).send().await;
    let wheel = board.read("PRI-2").await;
    assert_eq!(wheel["depends_on"], json!(["PRI-1"]));
    assert_eq!(wheel.get("blocked_by"), None, "a done one blocks nothing: {wheel}");
    let reply = api.post(&board.issues(), json!({"title": "x", "depends_on": ["PRI-9"]})).send().await;
    assert_eq!(reply.status, 404);
}

// Changing an issue.

#[tokio::test]
async fn an_edit_changes_each_field_notes_it_in_the_activity_and_tells_it() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let reply = api
        .patch(&board.at(&id), json!({"priority": "P1", "status": "started", "labels": ["math"], "assignee": "owner", "model": "sonnet", "effort": "high"}))
        .send()
        .await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let read = &reply.body;
    assert_eq!(read["priority"], json!("P1"));
    assert_eq!(read["status"], json!("in-progress"), "a kind is its first status");
    assert_eq!(read["labels"], json!(["math"]));
    assert_eq!(read["assignee"], json!("owner"), "owner is the owner's id, here with nobody named");
    assert_eq!((&read["model"], &read["effort"]), (&json!("sonnet"), &json!("high")));
    let events = reply.told();
    for event in [
        "issue.status primes PRI-1 backlog in-progress",
        "issue.priority primes PRI-1 ~ P1",
        "issue.assignee primes PRI-1 ~ owner",
        "issue.labels primes PRI-1 [] [\"math\"]",
        "issue.model primes PRI-1 ~ sonnet",
        "issue.effort primes PRI-1 ~ high",
    ] {
        assert!(events.contains(&event.to_string()), "{event} in {events:?}");
    }
    assert_eq!(reply.header("orrery-changed"), Some("primes"));
    let activity = board.activity(&id).await;
    let priority = activity.iter().find(|e| e["field"] == json!("priority")).unwrap();
    assert_eq!((priority.get("before"), &priority["after"], &priority["created_by"]), (None, &json!("P1"), &json!("owner")));
    // The same again changes nothing, so notes nothing.
    let again = api.patch(&board.at(&id), json!({"priority": "P1"})).send().await;
    assert_eq!(again.header("orrery-told"), None);
    assert_eq!(board.activity(&id).await.len(), activity.len());
}

#[tokio::test]
async fn a_session_starting_an_issue_takes_its_lock_so_a_second_at_once_is_refused() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let started = api.patch(&board.at(&id), json!({"status": "started"})).by_agent("claude").header("orrery-worked-by", "s%201").send().await;
    assert_eq!(started.status, 200, "{}", started.body);
    let lock = format!("SELECT count(*) FROM issues WHERE id = '{id}' AND claimed_session = 's 1' AND claimed_at IS NOT NULL");
    assert_eq!(api.count(&lock).await, 1, "the session is on it");
    let tied = format!("SELECT count(*) FROM issue_sessions WHERE issue = '{id}' AND session = 's 1'");
    assert_eq!(api.count(&tied).await, 1, "and it's the session's work");
    // Another starting it while the first's status lands is refused, and changes nothing.
    let second = api.patch(&board.at(&id), json!({"status": "started", "priority": "P2"})).by_agent("claude").header("orrery-worked-by", "s-2").send().await;
    assert_eq!(second.status, 409, "{}", second.body);
    assert!(message(&second).contains("already being worked on by another session (s 1)"), "{}", second.body);
    assert_eq!(board.read(&id).await["priority"], json!(null));
    assert_eq!(api.count(&tied).await, 1);
    // The same session starting it again keeps it.
    let again = api.patch(&board.at(&id), json!({"status": "started"})).by_agent("claude").header("orrery-worked-by", "s%201").send().await;
    assert_eq!(again.status, 200, "{}", again.body);
    // Once the mark has landed, the claim goes by who's there to hear, which the router checked: the next takes it.
    api.run("UPDATE issues SET claimed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", &[&id]).await;
    let later = api.patch(&board.at(&id), json!({"status": "started"})).by_agent("claude").header("orrery-worked-by", "s-2").send().await;
    assert_eq!(later.status, 200, "{}", later.body);
    assert_eq!(api.count(&format!("SELECT count(*) FROM issue_sessions WHERE issue = '{id}' AND session = 's-2'")).await, 1);
    // Closing it lets go of the lock, and an edit that moves no status ties no session.
    let closed = api.patch(&board.at(&id), json!({"status": "done"})).by_agent("claude").header("orrery-worked-by", "s-2").send().await;
    assert_eq!(closed.status, 200, "{}", closed.body);
    assert_eq!(api.count(&format!("SELECT count(*) FROM issues WHERE id = '{id}' AND claimed_session IS NULL")).await, 1);
    let words = api.patch(&board.at(&id), json!({"title": "Sieve, segmented"})).by_agent("claude").header("orrery-worked-by", "s-3").send().await;
    assert_eq!(words.status, 200, "{}", words.body);
    assert_eq!(api.count("SELECT count(*) FROM issue_sessions WHERE session = 's-3'").await, 0);
}

#[tokio::test]
async fn the_owner_starting_an_issue_takes_no_lock() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let owner = api.patch(&board.at(&id), json!({"status": "started"})).header("orrery-worked-by", "s-1").send().await;
    assert_eq!(owner.status, 200, "{}", owner.body);
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE claimed_session IS NOT NULL").await, 0);
    assert_eq!(api.count("SELECT count(*) FROM issue_sessions").await, 0);
}

#[tokio::test]
async fn a_title_or_description_is_noted_but_not_told_in_its_words() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve", "notes": "old"})).await;
    let reply = api.patch(&board.at(&id), json!({"title": "Segmented sieve", "notes": "new words"})).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!((&reply.body["title"], &reply.body["notes"]), (&json!("Segmented sieve"), &json!("new words")));
    assert_eq!(reply.told(), ["issue.title primes PRI-1", "issue.notes primes PRI-1"]);
    let activity = board.activity(&id).await;
    let title = activity.iter().find(|e| e["field"] == json!("title")).unwrap();
    assert_eq!((&title["before"], &title["after"]), (&json!("Sieve"), &json!("Segmented sieve")), "the activity keeps a title's words");
    let notes = activity.iter().find(|e| e["field"] == json!("notes")).unwrap();
    assert_eq!((notes.get("before"), notes.get("after")), (None, None), "but not a description's");
}

#[tokio::test]
async fn an_edit_with_a_bad_body_lists_every_problem_and_changes_nothing() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let reply = api.patch(&board.at(&id), json!({"title": "", "status": null, "effort": "huge", "model": "gpt", "labels": "math"})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(message(&reply), "5 problems in the body");
    assert_eq!(reply.problems().len(), 5);
    let reply = api.patch(&board.at(&id), json!({"choices": [{"key": "a", "question": "Q?", "options": [{"key": "x", "title": "X"}]}]})).send().await;
    assert_eq!(reply.problems(), ["\"choices\": a needs two options or more"]);
    let reply = api.patch(&board.at(&id), json!({"github_issues": ["12"]})).send().await;
    assert_eq!(reply.status, 400, "no GitHub repo to put #12 on: {}", reply.body);
    let reply = api.patch(&board.at(&id), json!([1])).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(board.read(&id).await["title"], json!("Sieve"));
    assert_eq!(board.fields_noted(&id).await, ["created"]);
}

#[tokio::test]
async fn the_words_from_before_statuses_still_set_one() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let status = |body: Value| {
        let (api, at) = (&api, board.at(&id));
        async move { api.patch(&at, body).send().await.body["status"].clone() }
    };
    assert_eq!(status(json!({"plan": "now"})).await, json!("todo"));
    assert_eq!(status(json!({"plan": null})).await, json!("backlog"));
    assert_eq!(status(json!({"status": "doing"})).await, json!("in-progress"));
    assert_eq!(status(json!({"status": "in-review"})).await, json!("in-review"));
    assert_eq!(status(json!({"status": "todo", "plan": null})).await, json!("backlog"));
    let reply = api.patch(&board.at(&id), json!({"plan": "soon"})).send().await;
    assert_eq!(reply.problems(), ["\"plan\" is \"soon\", not one of now, next, later (or null)"]);
}

#[tokio::test]
async fn an_issue_made_urgent_is_pushed_once() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve", "priority": "P2"})).await;
    let reply = api.patch(&board.at(&id), json!({"priority": "P0"})).send().await;
    assert_eq!(reply.said("orrery-urgent"), ["primes PRI-1"]);
    let reply = api.patch(&board.at(&id), json!({"title": "Sieve, now"})).send().await;
    assert_eq!(reply.header("orrery-urgent"), None, "it was urgent already");
    api.patch(&board.at(&id), json!({"status": "done"})).send().await;
    let reply = api.patch(&board.at(&id), json!({"status": "todo"})).send().await;
    assert_eq!(reply.said("orrery-urgent"), ["primes PRI-1"], "opened again, it's urgent again");
}

#[tokio::test]
async fn moving_an_issue_under_another_puts_it_in_its_parents_milestone_and_lifting_it_keeps_its_roots() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let p = &board.project;
    api.post(&format!("/api/projects/{p}/milestones"), json!({"title": "Launch"})).send().await;
    api.post(&format!("/api/projects/{p}/milestones"), json!({"title": "Later"})).send().await;
    let parent = board.issue(json!({"title": "Primes", "milestone": "1"})).await;
    let id = board.issue(json!({"title": "Sieve", "milestone": "2"})).await;
    let reply = api.patch(&board.at(&id), json!({"parent": parent})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["parent"], &reply.body["milestone"]), (&json!(parent), &json!("1")));
    assert!(reply.told().contains(&"issue.parent primes PRI-2 ~ PRI-1".to_string()), "{:?}", reply.told());
    let reply = api.patch(&board.at(&id), json!({"parent": null})).send().await;
    assert_eq!((&reply.body["parent"], &reply.body["milestone"]), (&Value::Null, &json!("1")), "lifted, it stays in its root's milestone");
    let reply = api.patch(&board.at(&id), json!({"parent": parent, "milestone": "2"})).send().await;
    assert_eq!(reply.status, 400);
    let reply = api.patch(&board.at(&id), json!({"milestone": "MLS-2"})).send().await;
    assert_eq!(reply.body["milestone"], json!("2"), "a milestone by its shown id");
    let reply = api.patch(&board.at(&id), json!({"milestone": "9"})).send().await;
    assert_eq!(reply.status, 404);
}

// Moving one to another project (ORR-1129).

#[tokio::test]
async fn an_issue_moves_to_another_project_with_its_sub_issues_comments_and_links() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let other = api.project("Composites").await;
    api.issue(&other, json!({"title": "Factor"})).await;
    let top = board.issue(json!({"title": "Sieve"})).await;
    let child = board.issue(json!({"title": "Bitmap", "parent": top})).await;
    let waiting = board.issue(json!({"title": "Wheel", "depends_on": [top]})).await;
    let reply = api.post(&format!("{}/comments", board.at(&top)), json!({"body": "Halfway"})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let reply = api.patch(&board.at(&top), json!({"project": other, "priority": "P1"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["id"], &reply.body["priority"]), (&json!("COM-2"), &json!("P1")), "the rest of the edit is made there");
    assert_eq!(reply.header("orrery-changed"), Some("composites, primes"));
    assert!(reply.told().contains(&"issue.project composites COM-2 primes composites".to_string()), "{:?}", reply.told());
    let theirs = |id: &str| format!("/api/projects/{other}/issues/{id}");
    let sub = api.get(&theirs("COM-3")).send().await;
    assert_eq!((&sub.body["title"], &sub.body["parent"]), (&json!("Bitmap"), &json!("COM-2")));
    let said = api.get(&format!("{}/comments", theirs("COM-2"))).send().await;
    assert_eq!(said.body[0]["body"], json!("Halfway"));
    // Its old ids are kept as aliases there, and what depended on it follows it.
    let by_old = api.get(&theirs(&top)).send().await;
    assert_eq!(by_old.body["id"], json!("COM-2"), "{}", by_old.body);
    assert_eq!(api.get(&theirs(&child)).send().await.body["id"], json!("COM-3"));
    assert_eq!(board.read(&waiting).await["depends_on"], json!(["composites/COM-2"]));
    assert_eq!(api.get(&board.at(&top)).send().await.status, 404);
}

#[tokio::test]
async fn a_sessions_moved_issue_is_its_work_where_it_is_now() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let other = api.project("Composites").await;
    let top = board.issue(json!({"title": "Sieve"})).await;
    let reply = api.patch(&board.at(&top), json!({"project": other})).agent_of_nobody().header("orrery-worked-by", "s-1").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let noted = format!("SELECT count(*) FROM issue_sessions WHERE project = '{other}' AND issue = 'COM-1' AND session = 's-1'");
    assert_eq!(api.count(&noted).await, 1);
    // Staying put, its address says which, so the router notes it.
    let still = board.issue(json!({"title": "Wheel"})).await;
    api.patch(&board.at(&still), json!({"title": "Wheel 2"})).agent_of_nobody().header("orrery-worked-by", "s-2").send().await;
    assert_eq!(api.count("SELECT count(*) FROM issue_sessions WHERE session = 's-2'").await, 0);
}

#[tokio::test]
async fn a_moved_issue_goes_under_a_parent_or_into_a_milestone_there_but_not_both() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let other = api.project("Composites").await;
    api.post(&format!("/api/projects/{other}/milestones"), json!({"title": "Launch"})).send().await;
    let theirs = api.issue(&other, json!({"title": "Factor"})).await;
    let a = board.issue(json!({"title": "Sieve"})).await;
    let b = board.issue(json!({"title": "Wheel"})).await;
    let reply = api.patch(&board.at(&a), json!({"project": other, "parent": theirs, "milestone": "1"})).send().await;
    assert_eq!(reply.status, 400, "{}", reply.body);
    let reply = api.patch(&board.at(&a), json!({"project": "nowhere"})).send().await;
    assert_eq!(reply.status, 404);
    let reply = api.patch(&board.at(&a), json!({"project": other, "parent": theirs})).send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["parent"], &reply.body["milestone"]), (200, &json!(theirs), &Value::Null), "{}", reply.body);
    let reply = api.patch(&board.at(&b), json!({"project": other, "milestone": "1"})).send().await;
    assert_eq!((&reply.body["parent"], &reply.body["milestone"]), (&Value::Null, &json!("1")), "{}", reply.body);
    assert_eq!(reply.header("orrery-changed"), Some("composites, primes"), "both boards change");
    // The same project is no move.
    let c = board.issue(json!({"title": "Gap"})).await;
    let reply = api.patch(&board.at(&c), json!({"project": board.project, "priority": "P2"})).send().await;
    assert_eq!((&reply.body["id"], &reply.body["priority"]), (&json!(c), &json!("P2")));
}

#[tokio::test]
async fn an_agent_moves_only_what_is_all_its_persons() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let other = api.project("Composites").await;
    let ana = board.assigned("Sieve", "ana").await;
    board.issue(json!({"title": "Bitmap", "parent": ana, "assignee": "bo"})).await;
    let reply = api.patch(&board.at(&ana), json!({"project": other})).agent_of("ana").send().await;
    assert_eq!(reply.status, 409, "{}", reply.body);
    assert!(message(&reply).starts_with("PRI-2 is assigned to bo"), "{}", reply.body);
    assert_eq!(board.read(&ana).await["id"], json!(ana), "nothing moved");
    let reply = api.patch(&board.at(&ana), json!({"project": other, "assignee": "bo"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 409);
    assert_eq!(board.read(&ana).await["id"], json!(ana), "nothing moved");
}

#[tokio::test]
async fn an_issue_cant_go_under_itself_or_its_own_sub_issue() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let top = board.issue(json!({"title": "Primes"})).await;
    let child = board.issue(json!({"title": "Sieve", "parent": top})).await;
    let grandchild = board.issue(json!({"title": "Bitmap", "parent": child})).await;
    let reply = api.patch(&board.at(&top), json!({"parent": top})).send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (400, "PRI-1 is this issue, so it can't be its parent"));
    let reply = api.patch(&board.at(&top), json!({"parent": grandchild})).send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (400, "PRI-3 is under this issue, so it can't be its parent"));
    let reply = api.patch(&board.at(&top), json!({"parent": "PRI-9"})).send().await;
    assert_eq!(reply.status, 404);
}

#[tokio::test]
async fn depends_on_refuses_itself_its_parent_and_a_loop() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let a = board.issue(json!({"title": "A"})).await;
    let b = board.issue(json!({"title": "B", "depends_on": [a]})).await;
    let c = board.issue(json!({"title": "C", "depends_on": [b]})).await;
    let child = board.issue(json!({"title": "A's", "parent": a})).await;
    let reply = api.patch(&board.at(&a), json!({"depends_on": [a]})).send().await;
    assert_eq!(message(&reply), "An issue can't depend on itself");
    let reply = api.patch(&board.at(&a), json!({"depends_on": [b]})).send().await;
    assert_eq!(message(&reply), "PRI-2 already depends on PRI-1, so PRI-1 can't depend on it");
    let reply = api.patch(&board.at(&a), json!({"depends_on": [c]})).send().await;
    assert_eq!(message(&reply), "PRI-3 already depends on PRI-1 (through PRI-2), so PRI-1 can't depend on it");
    let reply = api.patch(&board.at(&child), json!({"depends_on": [a]})).send().await;
    assert_eq!(message(&reply), "PRI-1 and PRI-4 are a parent and its sub-issue, so one can't depend on the other");
    let reply = api.patch(&board.at(&a), json!({"depends_on": ["/"]})).send().await;
    assert_eq!(reply.status, 400);
    // Dropping them all notes it once.
    let reply = api.patch(&board.at(&c), json!({"depends_on": null})).send().await;
    assert_eq!(reply.status, 200);
    assert!(reply.told().contains(&"issue.depends primes PRI-3 [\"PRI-2\"] ~".to_string()), "{:?}", reply.told());
    assert_eq!(board.read(&c).await.get("depends_on"), None);
}

#[tokio::test]
async fn an_issue_depends_on_another_projects_and_both_boards_change() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let other = api.project("Composites").await;
    let theirs = api.issue(&other, json!({"title": "Factor"})).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let reply = api.patch(&board.at(&id), json!({"depends_on": [format!("{other}/{theirs}")]})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["depends_on"], json!(["composites/COM-1"]));
    assert_eq!(reply.header("orrery-changed"), Some("primes, composites"));
}

#[tokio::test]
async fn an_issue_sets_its_position_and_choices() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    board.issue(json!({"title": "A"})).await;
    let b = board.issue(json!({"title": "B"})).await;
    api.patch(&board.at(&b), json!({"position": -1})).send().await;
    assert_eq!(ids(&api.get(&board.issues()).send().await.body)[0], b, "moved to the top");
    let reply = api.patch(&board.at(&b), json!({"choices": store_choice()})).send().await;
    assert_eq!(reply.status, 200);
    let choices = &reply.body["choices"];
    assert_eq!(choices[0]["key"], json!("store"));
    assert_eq!(choices[0]["pick"], json!("one"), "pick one unless it says any");
    assert_eq!(choices[0]["recommended"], json!(["A"]));
    let reply = api.patch(&board.at(&b), json!({"choices": null})).send().await;
    assert_eq!(reply.body["choices"], json!([]));
}

// Proposals: an agent's to edit, the owner's to commit.

#[tokio::test]
async fn an_agent_cant_commit_a_proposal_the_owner_hasnt_approved() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Sieve"})).await;
    let reply = api.patch(&board.at(&id), json!({"proposal": null})).by_agent("claude").send().await;
    assert_eq!(reply.status, 403);
    assert_eq!(message(&reply), "Committing PRI-1 is the owner's call until they approve it: it's waiting on them");
    assert_eq!(reply.body["data"]["permission"], json!("issues.edit"));
    assert_eq!(board.read(&id).await["proposal"], json!("pending"));
}

#[tokio::test]
async fn an_agent_cant_move_a_proposal_waiting_on_the_owner() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Sieve"})).await;
    let reply = api.patch(&board.at(&id), json!({"status": "todo", "release": null})).by_agent("claude").send().await;
    assert_eq!(reply.status, 403);
    assert_eq!(message(&reply), "PRI-1 is a proposal waiting on the owner, so its status and release aren't yours to change until they approve it");
    let reply = api.patch(&board.at(&id), json!({"assignee": "claude"})).by_agent("claude").send().await;
    assert_eq!(message(&reply), "PRI-1 is a proposal waiting on the owner, so its assignee isn't yours to change until they approve it");
    // Its words are still the agent's to change, and the owner moves it as they like.
    let reply = api.patch(&board.at(&id), json!({"title": "Segmented sieve"})).by_agent("claude").send().await;
    assert_eq!(reply.status, 200);
    let reply = api.patch(&board.at(&id), json!({"status": "todo"})).send().await;
    assert_eq!(reply.status, 200);
}

#[tokio::test]
async fn with_proposals_unrestricted_an_agent_moves_one() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let reply = api.patch("/api/settings", json!({"restrict_proposals": false})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let id = board.proposal(json!({"title": "Sieve"})).await;
    let reply = api.patch(&board.at(&id), json!({"status": "todo"})).by_agent("claude").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["status"], json!("todo"));
}

#[tokio::test]
async fn a_proposal_put_up_again_goes_to_the_owner_without_its_last_decision() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Sieve"})).await;
    let reply = api.post(&format!("{}/decide", board.at(&id)), json!({"decision": "changes", "note": "Smaller"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["proposal"], &reply.body["assignee"]), (&json!("changes"), &json!("claude")), "back to who proposed it");
    assert_eq!(reply.body["decision_note"], json!("Smaller"));
    let reply = api.patch(&board.at(&id), json!({"proposal": "pending", "assignee": "claude"})).by_agent("claude").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["proposal"], &reply.body["assignee"]), (&json!("pending"), &json!("owner")));
    assert_eq!((reply.body.get("decided_by"), reply.body.get("decision_note")), (None, None));
}

// Deciding a proposal.

#[tokio::test]
async fn approving_a_proposal_commits_it_into_todo_and_hands_it_back_with_a_comment() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Sieve"})).await;
    assert_eq!(board.read(&id).await["assignee"], json!("owner"), "a proposal waits on the owner");
    let reply = api.post(&format!("{}/decide", board.at(&id)), json!({"decision": "approved", "note": "  Go  "})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let read = &reply.body;
    assert_eq!(read.get("proposal"), None);
    assert_eq!(read["status"], json!("todo"));
    assert_eq!(read["assignee"], json!("claude"));
    assert_eq!(read["decided_by"], json!("owner"));
    assert_eq!(read["decision_note"], json!("Go"));
    let comments = board.comments(&id).await;
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0]["body"], json!("Approved this proposal.\n\nGo"));
    assert_eq!(reply.said("orrery-carry"), [format!("primes PRI-1 {}", comments[0]["id"])]);
    assert_eq!(reply.header("orrery-notice"), None);
    let events = reply.told();
    for event in ["issue.proposal primes PRI-1 pending approved", "issue.assignee primes PRI-1 owner claude", "comment.added primes PRI-1"] {
        assert!(events.contains(&event.to_string()), "{event} in {events:?}");
    }
    let noted = board.fields_noted(&id).await;
    assert!(noted.ends_with(&["proposal".into(), "assignee".into(), "status".into(), "proposal".into()]), "{noted:?}");
}

#[tokio::test]
async fn approving_a_proposal_thats_already_moving_leaves_its_status() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Sieve", "status": "in-review"})).await;
    let reply = api.post(&format!("{}/decide", board.at(&id)), json!({"decision": "approved"})).send().await;
    assert_eq!(reply.body["status"], json!("in-review"));
}

#[tokio::test]
async fn rejecting_a_proposal_is_said_to_the_session_quietly_and_leaves_it_where_it_was() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Sieve"})).await;
    let reply = api.post(&format!("{}/decide", board.at(&id)), json!({"decision": "rejected"})).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!((&reply.body["proposal"], &reply.body["status"]), (&json!("rejected"), &json!("backlog")));
    let comments = board.comments(&id).await;
    assert_eq!(comments[0]["body"], json!("Rejected this proposal."));
    assert_eq!(reply.said("orrery-carry"), [format!("primes PRI-1 {} quiet", comments[0]["id"])]);
    // An agent can't commit a rejected one either.
    let reply = api.patch(&board.at(&id), json!({"proposal": null})).by_agent("claude").send().await;
    assert_eq!(message(&reply), "Committing PRI-1 is the owner's call until they approve it: it's rejected");
}

#[tokio::test]
async fn only_the_owner_decides_a_proposal() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Sieve"})).await;
    let decide = format!("{}/decide", board.at(&id));
    let reply = api.post(&decide, json!({"decision": "approved"})).by_agent("claude").send().await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.body["data"]["permission"], json!("proposals.decide"));
    assert!(message(&reply).contains("owner only for a session"), "{}", reply.body);
    let reply = api.post(&decide, json!({"decision": "approved"})).untrusted().send().await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.body["data"]["permission"], json!("proposals.decide"));
    assert!(message(&reply).starts_with("This session reads what others wrote"), "{}", reply.body);
    assert_eq!(board.read(&id).await["proposal"], json!("pending"));
    assert!(board.comments(&id).await.is_empty());
}

#[tokio::test]
async fn deciding_what_isnt_a_proposal_or_without_a_decision_is_a_400() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let plain = board.issue(json!({"title": "Plain"})).await;
    let reply = api.post(&format!("{}/decide", board.at(&plain)), json!({"decision": "approved"})).send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (400, "PRI-1 isn't a proposal; make it one with PATCH {\"proposal\": \"pending\"}"));
    let id = board.proposal(json!({"title": "Sieve"})).await;
    let decide = format!("{}/decide", board.at(&id));
    let reply = api.post(&decide, json!({})).send().await;
    assert_eq!(reply.problems(), ["missing \"decision\""]);
    let reply = api.post(&decide, json!({"decision": "maybe", "note": 3, "why": "x"})).send().await;
    assert_eq!(reply.problems().len(), 3, "{:?}", reply.problems());
    let reply = api.post(&format!("{}/decide", board.at("PRI-9")), json!({"decision": "approved"})).send().await;
    assert_eq!(reply.status, 404);
}

#[tokio::test]
async fn approving_a_proposal_with_choices_keeps_the_picks_and_says_them() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let recommended = board.proposal(json!({"title": "Store", "choices": store_choice()})).await;
    let reply = api.post(&format!("{}/decide", board.at(&recommended)), json!({"decision": "approved"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["picks"], json!({"store": ["A"]}), "the recommendation, when none are sent");
    assert_eq!(board.comments(&recommended).await[0]["body"], json!("Approved this proposal with:\n- Which store? → **A** SQLite"));
    let picked = board.proposal(json!({"title": "Store", "choices": store_choice()})).await;
    let decide = format!("{}/decide", board.at(&picked));
    let reply = api.post(&decide, json!({"decision": "approved", "picks": {"store": ["C"]}})).send().await;
    assert_eq!(message(&reply), "Can't approve PRI-2 with those picks: store has no option C");
    let reply = api.post(&decide, json!({"decision": "approved", "picks": {"store": ["A", "B"]}})).send().await;
    assert_eq!(message(&reply), "Can't approve PRI-2 with those picks: pick one option for store (Which store?)");
    let reply = api.post(&decide, json!({"decision": "rejected", "picks": {"store": ["B"]}})).send().await;
    assert_eq!(message(&reply), "\"picks\" go with approving a proposal that has choices");
    let reply = api.post(&decide, json!({"decision": "approved", "picks": {"store": ["B"]}})).send().await;
    assert_eq!(reply.body["picks"], json!({"store": ["B"]}));
}

#[tokio::test]
async fn asking_to_explore_an_option_keeps_it_and_says_how_to_go_on() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Store", "choices": store_choice()})).await;
    let decide = format!("{}/decide", board.at(&id));
    let reply = api.post(&decide, json!({"decision": "approved", "explore": {"choice": "store", "option": "B"}})).send().await;
    assert_eq!(message(&reply), "\"explore\" goes with asking for changes");
    let reply = api.post(&decide, json!({"decision": "changes", "explore": {"choice": "store", "option": "Z"}})).send().await;
    assert_eq!(message(&reply), "PRI-1 has no option Z in a choice \"store\"");
    let reply = api.post(&decide, json!({"decision": "changes", "explore": {"choice": "store", "option": "B"}})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["explore"], json!({"choice": "store", "option": "B"}));
    assert_eq!(
        board.comments(&id).await[0]["body"],
        json!("Asked to explore B (Postgres) further: add a choice that goes down it, then put the proposal up again.")
    );
}

#[tokio::test]
async fn approving_an_urgent_proposal_pushes_it() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.proposal(json!({"title": "Down", "priority": "P0"})).await;
    let reply = api.post(&format!("{}/decide", board.at(&id)), json!({"decision": "approved"})).send().await;
    assert_eq!(reply.said("orrery-urgent"), ["primes PRI-1"]);
}

#[tokio::test]
async fn deciding_many_proposals_answers_for_each_once() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let a = board.proposal(json!({"title": "A", "priority": "P0"})).await;
    let b = board.proposal(json!({"title": "B"})).await;
    let plain = board.issue(json!({"title": "Plain"})).await;
    let reply = api.post(&format!("{}/decide", board.issues()), json!({"ids": [a, b, a, plain, "PRI-9"], "decision": "approved"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let results = reply.body.as_array().unwrap();
    assert_eq!(results.len(), 4, "an id once: {results:?}");
    assert_eq!(results[0], json!({"id": a, "ok": true}));
    assert_eq!(results[1], json!({"id": b, "ok": true}));
    assert_eq!(results[2]["ok"], json!(false));
    assert!(results[2]["error"].as_str().unwrap().contains("isn't a proposal"), "{}", results[2]);
    assert_eq!(results[3]["error"], json!("No issue PRI-9 in primes"));
    assert_eq!(reply.said("orrery-carry").len(), 2);
    assert_eq!(reply.said("orrery-urgent"), ["primes PRI-1"]);
    assert_eq!(board.read(&a).await.get("proposal"), None);
    assert_eq!(board.read(&b).await["status"], json!("todo"));
}

#[tokio::test]
async fn deciding_many_proposals_takes_no_picks_and_approves_none_on_a_guess() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let open = json!([{"key": "store", "question": "Which store?", "options": [{"key": "A", "title": "SQLite"}, {"key": "B", "title": "Postgres"}]}]);
    let id = board.proposal(json!({"title": "Store", "choices": open})).await;
    let decide = format!("{}/decide", board.issues());
    let reply = api.post(&decide, json!({"ids": [id], "decision": "approved", "picks": {"store": ["A"]}})).send().await;
    assert_eq!(reply.status, 400);
    let reply = api.post(&decide, json!({"decision": "approved"})).send().await;
    assert_eq!(message(&reply), "Send \"ids\": the issues, as a list of their ids");
    let reply = api.post(&decide, json!({"ids": [], "decision": "approved"})).send().await;
    assert_eq!(reply.status, 400);
    let reply = api.post(&decide, json!({"ids": [id], "decision": "approved"})).send().await;
    assert_eq!(reply.body[0]["error"], json!("Needs your picks: nothing is recommended for \"Which store?\""));
    let reply = api.post(&decide, json!({"ids": [id], "decision": "rejected"})).send().await;
    assert_eq!(reply.body[0]["ok"], json!(true), "a rejection needs no picks");
    let reply = api.post("/api/projects/nowhere/issues/decide", json!({"ids": [id], "decision": "rejected"})).send().await;
    assert_eq!(reply.status, 404);
}

#[tokio::test]
async fn an_approved_proposal_goes_to_the_person_whose_agent_proposed_it() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "proposal": "pending"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["assignee"], json!("steffen"), "it waits on the owner");
    let id = reply.body["id"].as_str().unwrap().to_string();
    // Its agent's to edit while it waits, though it's the owner's; another person's agent's not.
    let reply = api.patch(&board.at(&id), json!({"title": "Segmented sieve"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let reply = api.patch(&board.at(&id), json!({"title": "Bo's sieve"})).agent_of("bo").send().await;
    assert_eq!(reply.status, 409);
    let reply = api.post(&format!("{}/decide", board.at(&id)), json!({"decision": "approved"})).send().await;
    assert_eq!(reply.body["assignee"], json!("ana"));
}

// Many issues at once.

#[tokio::test]
async fn a_bulk_change_edits_each_issue_on_its_own_and_answers_for_each_once() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let a = board.issue(json!({"title": "A", "labels": ["old", "keep"]})).await;
    let b = board.issue(json!({"title": "B"})).await;
    let body = json!({"ids": [a, b, a, "PRI-9"], "set": {"priority": "P0", "status": "todo"}, "labels": {"add": ["new"], "remove": ["old"]}});
    let reply = api.patch(&board.issues(), body).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!([{"id": a, "ok": true}, {"id": b, "ok": true}, {"id": "PRI-9", "ok": false, "error": "No issue PRI-9 in primes"}]));
    let read_a = board.read(&a).await;
    assert_eq!((&read_a["priority"], &read_a["status"], &read_a["labels"]), (&json!("P0"), &json!("todo"), &json!(["keep", "new"])));
    assert_eq!(board.read(&b).await["labels"], json!(["new"]));
    assert_eq!(reply.said("orrery-urgent"), ["primes PRI-1", "primes PRI-2"]);
    assert_eq!(reply.told().iter().filter(|t| t.starts_with("issue.priority")).count(), 2);
    // Each edit's rows, and the project once more as the batch ends.
    let changed = api.outbox().await.iter().filter(|row| row.kind == "project.changed").count();
    assert_eq!(changed, 1 + 2 + 2 + 1, "the project and its two issues made, each edited, then the batch: {:?}", api.outbox().await);
}

#[tokio::test]
async fn a_bulk_change_takes_only_its_fields() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let a = board.issue(json!({"title": "A"})).await;
    let reply = api.patch(&board.issues(), json!({"ids": [a], "set": {"title": "x", "notes": "y"}})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(
        message(&reply),
        "Many issues at once take status, priority, assignee, milestone, release, epic in \"set\", and labels as {add, remove}; not title, notes"
    );
    let reply = api.patch(&board.issues(), json!({"ids": [a], "labels": {"add": "x"}})).send().await;
    assert_eq!(message(&reply), "\"labels.add\" should be a list of labels");
    let reply = api.patch(&board.issues(), json!({"ids": "PRI-1", "set": {"priority": "P1"}})).send().await;
    assert_eq!(message(&reply), "Send \"ids\": the issues, as a list of their ids");
    let reply = api.patch(&board.issues(), json!({"ids": [a], "set": {"priority": "P7"}})).send().await;
    assert_eq!(reply.status, 200, "a bad value is the issue's own refusal");
    assert_eq!(reply.body[0]["ok"], json!(false));
    assert_eq!(board.read(&a).await.get("priority"), None);
    assert_eq!(api.patch("/api/projects/nowhere/issues", json!({"ids": [a]})).send().await.status, 404);
}

// Deleting.

#[tokio::test]
async fn deleting_an_issue_takes_its_sub_issues_and_comments_with_it() {
    use sqlx::Row;
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let parent = board.issue(json!({"title": "Primes"})).await;
    let child = board.issue(json!({"title": "Sieve", "parent": parent})).await;
    let other = board.issue(json!({"title": "Other"})).await;
    api.post(&format!("{}/comments", board.at(&child)), json!({"body": "note"})).send().await;
    let reply = api.delete(&board.at(&parent)).send().await;
    assert_eq!(reply.status, 204);
    assert_eq!(reply.told(), ["issue.deleted primes PRI-1"]);
    assert_eq!(reply.header("orrery-changed"), Some("primes"));
    assert_eq!(api.get(&board.at(&parent)).send().await.status, 404);
    assert_eq!(api.get(&board.at(&child)).send().await.status, 404);
    assert_eq!(ids(&api.get(&board.issues()).send().await.body), [other]);
    let left: i64 = sqlx::query("SELECT CAST(count(*) AS BIGINT) AS n FROM comments").fetch_one(&api.app.pool).await.unwrap().get("n");
    assert_eq!(left, 0, "the sub-issue's comment went with it");
    assert_eq!(api.delete(&board.at(&parent)).send().await.status, 404);
}

#[tokio::test]
async fn deleting_an_issue_frees_what_depended_on_it_and_notes_it_there() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let blocker = board.issue(json!({"title": "Sieve"})).await;
    let waiting = board.issue(json!({"title": "Wheel", "depends_on": [blocker]})).await;
    api.delete(&board.at(&blocker)).send().await;
    let read = board.read(&waiting).await;
    assert_eq!((read.get("depends_on"), read.get("blocked_by")), (None, None));
    let last = board.activity(&waiting).await.last().unwrap().clone();
    assert_eq!((&last["field"], &last["before"], last.get("after"), &last["created_by"]), (&json!("depends"), &json!("[\"PRI-1\"]"), None, &json!("orrery")));
}

#[tokio::test]
async fn an_agent_cant_delete_what_the_owner_made() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let owners = board.issue(json!({"title": "Owner's"})).await;
    let reply = api.delete(&board.at(&owners)).by_agent("claude").send().await;
    assert_eq!(reply.status, 403);
    assert_eq!(message(&reply), "Deleting PRI-1 is the owner's call: PRI-1 was made by the owner");
    assert_eq!(reply.body["data"]["permission"], json!("issues.delete"));
    // Its own, with the owner's comment on it, neither.
    let reply = api.post(&board.issues(), json!({"title": "Agent's"})).by_agent("claude").send().await;
    let agents = reply.body["id"].as_str().unwrap().to_string();
    api.post(&format!("{}/comments", board.at(&agents)), json!({"body": "mine"})).send().await;
    let reply = api.delete(&board.at(&agents)).by_agent("claude").send().await;
    assert_eq!(message(&reply), "Deleting PRI-2 is the owner's call: comment 1 on PRI-2 was made by the owner");
    let reply = api.post(&board.issues(), json!({"title": "Agent's own"})).by_agent("claude").send().await;
    let own = reply.body["id"].as_str().unwrap().to_string();
    assert_eq!(api.delete(&board.at(&own)).by_agent("claude").send().await.status, 204);
}

#[tokio::test]
async fn deleting_many_answers_for_each_and_one_gone_with_its_parent_is_ok() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let parent = board.issue(json!({"title": "Primes"})).await;
    let child = board.issue(json!({"title": "Sieve", "parent": parent})).await;
    let reply = api.delete(&board.issues()).json(json!({"ids": [parent, child, child, "PRI-9"]})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, json!([{"id": parent, "ok": true}, {"id": child, "ok": true}, {"id": "PRI-9", "ok": false, "error": "No issue PRI-9 in primes"}]));
    assert_eq!(reply.told(), ["issue.deleted primes PRI-1"]);
    let reply = api.delete(&board.issues()).json(json!({"ids": [1]})).send().await;
    assert_eq!(reply.status, 400);
}

// Claims.

#[tokio::test]
async fn the_owner_takes_up_an_issue_and_lets_it_go_and_it_stays_theirs() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let claim = format!("{}/claim", board.at(&id));
    let reply = api.post(&claim, json!({})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["assignee"], &reply.body["claimed_by"]), (&json!("steffen"), &json!("steffen")));
    assert!(reply.body["claimed_at"].is_string());
    assert_eq!(reply.told(), ["issue.assignee primes PRI-1 ~ steffen", "issue.claim primes PRI-1 ~ steffen"]);
    let reply = api.delete(&claim).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!((&reply.body["assignee"], reply.body.get("claimed_by")), (&json!("steffen"), None));
    assert_eq!(reply.told(), ["issue.claim primes PRI-1 steffen ~"]);
    // Letting go of what nobody holds changes nothing.
    let reply = api.delete(&claim).send().await;
    assert_eq!((reply.status.as_u16(), reply.header("orrery-told")), (200, None));
    assert_eq!(api.post(&format!("{}/claim", board.at("PRI-9")), json!({})).send().await.status, 404);
}

#[tokio::test]
async fn a_person_takes_up_an_issue_thats_nobodys_and_it_becomes_theirs() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let reply = api.post(&format!("{}/claim", board.at(&id)), json!({})).person("ana").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["assignee"], &reply.body["claimed_by"]), (&json!("ana"), &json!("ana")));
    // A member's write names them in the outbox.
    let rows = api.outbox().await;
    let claim = rows.iter().find(|row| row.kind == "issue.claim").unwrap();
    assert_eq!(claim.payload(), json!({"to": "ana", "person": "ana"}));
}

#[tokio::test]
async fn an_agent_takes_up_its_persons_issue_but_not_one_thats_nobodys() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let anas = board.assigned("Sieve", "ana").await;
    let reply = api.post(&format!("{}/claim", board.at(&anas)), json!({})).agent_of("ana").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["assignee"], &reply.body["claimed_by"]), (&json!("ana"), &json!("ana")));
    let nobodys = board.issue(json!({"title": "Wheel"})).await;
    let reply = api.post(&format!("{}/claim", board.at(&nobodys)), json!({})).agent_of("ana").send().await;
    assert_eq!(reply.status, 409);
    assert_eq!(message(&reply), "PRI-2 is assigned to nobody, and this session is ana's, so it can't take it up; a person has to assign it first");
}

#[tokio::test]
async fn an_agent_cant_take_up_another_persons_issue() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let bos = board.assigned("Sieve", "bo").await;
    let reply = api.post(&format!("{}/claim", board.at(&bos)), json!({})).agent_of("ana").send().await;
    assert_eq!(reply.status, 409);
    assert_eq!(message(&reply), "PRI-1 is assigned to bo, and this session is ana's, so it can't take it up; comment on it instead, or pick another issue");
    let read = board.read(&bos).await;
    assert_eq!((&read["assignee"], read.get("claimed_by")), (&json!("bo"), None));
}

#[tokio::test]
async fn a_session_naming_nobody_cant_take_up_make_change_or_delete_an_issue() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.assigned("Sieve", "ana").await;
    for reply in [
        api.post(&format!("{}/claim", board.at(&id)), json!({})).agent_of_nobody().send().await,
        api.patch(&board.at(&id), json!({"priority": "P1"})).agent_of_nobody().send().await,
        api.post(&board.issues(), json!({"title": "New"})).agent_of_nobody().send().await,
        api.delete(&board.at(&id)).agent_of_nobody().send().await,
    ] {
        assert_eq!(reply.status, 409, "{}", reply.body);
        assert!(
            message(&reply).starts_with("This session names nobody, and this orrery has more than one person, so it can read and comment"),
            "{}",
            reply.body
        );
    }
    // Commenting stays open.
    let reply = api.post(&format!("{}/comments", board.at(&id)), json!({"body": "Seen it"})).agent_of_nobody().send().await;
    assert_eq!(reply.status, 201);
}

#[tokio::test]
async fn an_untrusted_session_can_comment_but_not_change_an_issue() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.assigned("Sieve", "ana").await;
    // Its rails refuse it at the door (ORR-1059): only proposals, and comments on its own.
    let reply = api.patch(&board.at(&id), json!({"title": "Pwned"})).untrusted().send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["data"]["permission"]), (403, &json!("issues.edit")), "{}", reply.body);
    let reply = api.post(&format!("{}/claim", board.at(&id)), json!({})).untrusted().send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["data"]["permission"]), (403, &json!("issues.claim")), "{}", reply.body);
    let reply = api.post(&format!("{}/comments", board.at(&id)), json!({"body": "From outside"})).untrusted().send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["data"]["permission"]), (403, &json!("comments.write")), "{}", reply.body);
    let raised = board.issue(json!({"title": "From outside", "labels": ["external"], "proposal": "pending"})).await;
    let reply = api.post(&format!("{}/comments", board.at(&raised)), json!({"body": "From outside", "asks": "decision"})).untrusted().send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.said("orrery-notice").len(), 1, "it rings the owner's bell");
    assert_eq!(reply.header("orrery-carry"), None, "but isn't carried to the session as a person's words");
    let read = board.read(&id).await;
    assert_eq!((&read["assignee"], &read["title"]), (&json!("ana"), &json!("Sieve")), "its ask takes nobody's issue");
}

#[tokio::test]
async fn only_the_holder_or_the_owner_lets_a_claim_go() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.assigned("Sieve", "ana").await;
    let claim = format!("{}/claim", board.at(&id));
    api.post(&claim, json!({})).agent_of("ana").send().await;
    let reply = api.delete(&claim).agent_of("bo").send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (409, "PRI-1 is held by ana, so only they or the owner can let it go"));
    let reply = api.delete(&claim).agent_of("ana").send().await;
    assert_eq!(reply.status, 200);
    assert_eq!((&reply.body["assignee"], reply.body.get("claimed_by")), (&json!("ana"), None));
    api.post(&claim, json!({})).agent_of("ana").send().await;
    let reply = api.delete(&claim).send().await;
    assert_eq!((reply.status.as_u16(), reply.body.get("claimed_by")), (200, None), "the owner's on anyone's");
}

#[tokio::test]
async fn the_owner_takes_over_anothers_claim() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.assigned("Sieve", "bo").await;
    let claim = format!("{}/claim", board.at(&id));
    api.post(&claim, json!({})).agent_of("bo").send().await;
    let reply = api.post(&claim, json!({})).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!((&reply.body["assignee"], &reply.body["claimed_by"]), (&json!("steffen"), &json!("steffen")));
    assert_eq!(reply.told(), ["issue.assignee primes PRI-1 bo steffen", "issue.claim primes PRI-1 bo steffen"]);
}

// The rails on changing an issue.

#[tokio::test]
async fn an_agent_cant_change_another_persons_issue() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let bos = board.assigned("Sieve", "bo").await;
    let reply = api.patch(&board.at(&bos), json!({"priority": "P1"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 409);
    assert_eq!(message(&reply), "PRI-1 is assigned to bo, and this session is ana's, so it can't change it; comment on it instead, or pick another issue");
    assert_eq!(board.read(&bos).await.get("priority"), None);
    // `claude` counts as the owner's, and one who isn't a person as nobody.
    let claudes = board.assigned("Wheel", "claude").await;
    let reply = api.patch(&board.at(&claudes), json!({"priority": "P1"})).agent_of("ana").send().await;
    assert!(message(&reply).starts_with("PRI-2 is assigned to steffen"), "{}", reply.body);
    let strangers = board.assigned("Gap", "zed").await;
    let reply = api.patch(&board.at(&strangers), json!({"priority": "P1"})).agent_of("ana").send().await;
    assert!(message(&reply).starts_with("PRI-3 is assigned to nobody"), "{}", reply.body);
}

#[tokio::test]
async fn with_one_person_there_are_no_rails() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.assigned("Sieve", "bo").await;
    let reply = api.patch(&board.at(&id), json!({"priority": "P1", "assignee": "zed"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["assignee"], json!("zed"));
}

#[tokio::test]
async fn an_agent_starting_its_persons_issue_takes_it_up_and_closing_it_lets_go() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.assigned("Sieve", "ana").await;
    let reply = api.patch(&board.at(&id), json!({"status": "in-progress"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["claimed_by"], json!("ana"));
    let reply = api.patch(&board.at(&id), json!({"status": "done"})).agent_of("ana").send().await;
    assert_eq!((&reply.body["status"], reply.body.get("claimed_by")), (&json!("done"), None));
    let reply = api.patch(&board.at(&id), json!({"status": "todo"})).agent_of("ana").send().await;
    assert_eq!(reply.body.get("claimed_by"), None, "reopening doesn't bring the claim back");
}

#[tokio::test]
async fn an_agent_cant_start_an_issue_another_person_has_taken_up() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.assigned("Sieve", "ana").await;
    api.run("UPDATE issues SET claimed_by = ? WHERE id = ?", &["bo", &id]).await;
    let reply = api.patch(&board.at(&id), json!({"status": "in-progress"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 409);
    assert_eq!(message(&reply), "PRI-1 has just been taken or reassigned; read it again, or pick another issue");
    let read = board.read(&id).await;
    assert_eq!((&read["status"], &read["claimed_by"]), (&json!("backlog"), &json!("bo")), "nothing changed");
}

#[tokio::test]
async fn an_agent_hands_its_issue_back_to_the_owner_but_never_to_someone_else() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.assigned("Sieve", "ana").await;
    let reply = api.patch(&board.at(&id), json!({"assignee": "bo"})).agent_of("ana").send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (409, "Only people assign: this session can't give PRI-1 to bo"));
    let reply = api.patch(&board.at(&id), json!({"assignee": "claude"})).agent_of("ana").send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["assignee"]), (200, &json!("ana")), "itself is who has it already");
    assert_eq!(reply.header("orrery-told"), None);
    api.post(&format!("{}/claim", board.at(&id)), json!({})).agent_of("ana").send().await;
    let reply = api.patch(&board.at(&id), json!({"assignee": "owner"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["assignee"], reply.body.get("claimed_by")), (&json!("steffen"), None), "handed on, the claim ends");
}

#[tokio::test]
async fn an_agent_moves_an_issue_only_under_one_its_person_holds() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let anas = board.assigned("Sieve", "ana").await;
    let bos = board.assigned("Primes", "bo").await;
    let anas_too = board.assigned("Factor", "ana").await;
    let reply = api.patch(&board.at(&anas), json!({"parent": bos})).agent_of("ana").send().await;
    assert_eq!(reply.status, 409);
    assert!(message(&reply).ends_with("so it can't move an issue under it; comment on it instead, or pick another issue"), "{}", reply.body);
    let reply = api.patch(&board.at(&anas), json!({"parent": anas_too})).agent_of("ana").send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["parent"]), (200, &json!(anas_too)));
}

#[tokio::test]
async fn an_agents_bulk_change_refuses_only_the_issues_that_arent_its_persons() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let anas = board.assigned("Sieve", "ana").await;
    let bos = board.assigned("Wheel", "bo").await;
    let reply = api.patch(&board.issues(), json!({"ids": [anas, bos], "set": {"priority": "P1"}})).agent_of("ana").send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body[0], json!({"id": anas, "ok": true}));
    assert_eq!(reply.body[1]["ok"], json!(false));
    assert!(reply.body[1]["error"].as_str().unwrap().starts_with("PRI-2 is assigned to bo"), "{}", reply.body);
    assert_eq!(board.read(&anas).await["priority"], json!("P1"));
    assert_eq!(board.read(&bos).await.get("priority"), None);
    // An agent's change pushes no urgent work; a person's own does.
    let reply = api.patch(&board.issues(), json!({"ids": [anas], "set": {"priority": "P0"}})).agent_of("ana").send().await;
    assert_eq!(reply.header("orrery-urgent"), None);
    let reply = api.patch(&board.issues(), json!({"ids": [bos], "set": {"priority": "P0"}})).person("bo").send().await;
    assert_eq!(reply.said("orrery-urgent"), ["primes PRI-2"]);
}

#[tokio::test]
async fn an_agent_deletes_only_its_persons_issues_all_the_way_down() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let reply = api.post(&board.issues(), json!({"title": "x"})).agent_of("ana").send().await;
    let top = reply.body["id"].as_str().unwrap().to_string();
    api.patch(&board.at(&top), json!({"assignee": "ana"})).send().await;
    let reply = api.post(&board.issues(), json!({"title": "y", "parent": top})).agent_of("ana").send().await;
    let child = reply.body["id"].as_str().unwrap().to_string();
    api.patch(&board.at(&child), json!({"assignee": "bo"})).send().await;
    let reply = api.delete(&board.at(&top)).agent_of("ana").send().await;
    assert_eq!(reply.status, 409, "its sub-issue is bo's: {}", reply.body);
    assert!(message(&reply).starts_with("PRI-2 is assigned to bo"), "{}", reply.body);
    api.patch(&board.at(&child), json!({"assignee": "ana"})).send().await;
    assert_eq!(api.delete(&board.at(&top)).agent_of("ana").send().await.status, 204);
}

// The rails on making an issue.

#[tokio::test]
async fn an_agents_new_issue_at_the_top_stays_nobodys() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let reply = api.post(&board.issues(), json!({"title": "Sieve"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body.get("assignee"), None);
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "assignee": "bo"})).agent_of("ana").send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (409, "Only people assign: this session can't give a new issue to bo"));
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "assignee": "ana"})).agent_of("ana").send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (409, "Only people assign: a new issue stays unassigned until one does"), "nor to its own person");
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "assignee": "owner"})).agent_of("ana").send().await;
    assert_eq!((reply.status.as_u16(), &reply.body["assignee"]), (201, &json!("steffen")), "it can ask for the owner");
    for status in ["in-progress", "done"] {
        let reply = api.post(&board.issues(), json!({"title": "Sieve", "status": status})).agent_of("ana").send().await;
        assert_eq!(reply.status, 409);
        assert_eq!(
            message(&reply),
            format!("A new issue is assigned to nobody, so this session can't make it {status}; leave it in Todo or Backlog for a person to assign")
        );
    }
}

#[tokio::test]
async fn an_agents_sub_issue_under_its_persons_issue_is_theirs_and_started_is_taken_up() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let anas = board.assigned("Primes", "ana").await;
    let bos = board.assigned("Wheel", "bo").await;
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "parent": anas, "status": "in-progress"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!((&reply.body["assignee"], &reply.body["claimed_by"]), (&json!("ana"), &json!("ana")));
    let reply = api.post(&board.issues(), json!({"title": "Idea", "parent": anas, "proposal": "pending"})).agent_of("ana").send().await;
    assert_eq!(reply.body["assignee"], json!("steffen"), "a proposal waits on the owner");
    let reply = api.post(&board.issues(), json!({"title": "Sieve", "parent": bos})).agent_of("ana").send().await;
    assert_eq!(reply.status, 409);
    assert!(message(&reply).ends_with("so it can't file a sub-issue under it; comment on it instead, or pick another issue"), "{}", reply.body);
}

// Comments.

#[tokio::test]
async fn the_owners_comment_is_carried_to_the_session_and_read_back() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let reply = api.post(&format!("{}/comments", board.at(&id)), json!({"body": "Use a bitmap"})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let comment = reply.body.clone();
    assert_eq!((&comment["body"], &comment["protected"], &comment["created_by"]), (&json!("Use a bitmap"), &json!(true), &json!("owner")));
    assert_eq!((comment.get("asks"), comment.get("answered")), (None, None));
    let n = comment["id"].as_i64().unwrap();
    assert_eq!(reply.said("orrery-carry"), [format!("primes PRI-1 {n}")]);
    assert_eq!(reply.header("orrery-notice"), None, "the owner's own words ring no bell");
    assert_eq!(reply.told(), ["comment.added primes PRI-1"]);
    assert_eq!(board.read(&id).await["comments"], json!(1));
    let read = api.get(&format!("{}/comments/{n}", board.at(&id))).send().await;
    assert_eq!(read.body, comment);
    assert_eq!(board.comments(&id).await, [comment]);
    assert_eq!(api.get(&format!("{}/comments/99", board.at(&id))).send().await.status, 404);
    assert_eq!(api.get(&format!("{}/comments/abc", board.at(&id))).send().await.status, 404);
}

#[tokio::test]
async fn an_agents_comment_rings_the_owners_bell_and_keeps_its_session() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let reply = api
        .post(&format!("{}/comments", board.at(&id)), json!({"body": "Done the bitmap"}))
        .by_agent("claude")
        .header("orrery-actor-session", "s1")
        .send()
        .await;
    assert_eq!(reply.status, 201);
    assert_eq!((&reply.body["protected"], &reply.body["session_name"]), (&json!(false), &json!("s1")));
    assert_eq!(reply.said("orrery-notice"), [format!("primes PRI-1 {}", reply.body["id"])]);
    assert_eq!(reply.header("orrery-carry"), None);
}

#[tokio::test]
async fn a_comment_with_a_bad_body_lists_its_problems() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let comments = format!("{}/comments", board.at(&id));
    let reply = api.post(&comments, json!({"asks": "help", "to": "x"})).send().await;
    assert_eq!(reply.status, 400);
    let listed = reply.problems();
    assert_eq!(listed.len(), 3, "{listed:?}");
    assert!(listed.contains(&"missing \"body\"".to_string()));
    assert!(listed.contains(&"\"asks\" is \"help\", not one of decision, feedback (or null)".to_string()));
    let reply = api.post(&comments, json!({"body": "  "})).send().await;
    assert_eq!(reply.problems(), ["\"body\" can't be empty"]);
    assert!(board.comments(&id).await.is_empty());
    let reply = api.post(&format!("{}/comments", board.at("PRI-9")), json!({"body": "x"})).send().await;
    assert_eq!(reply.status, 404);
}

#[tokio::test]
async fn an_agents_question_waits_on_the_owner_and_their_answer_hands_the_issue_back() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve", "assignee": "claude"})).await;
    let comments = format!("{}/comments", board.at(&id));
    let reply = api.post(&comments, json!({"body": "Bitmap or list?", "asks": "decision"})).by_agent("claude").send().await;
    assert_eq!(reply.status, 201);
    assert_eq!((&reply.body["asks"], &reply.body["answered"]), (&json!("decision"), &json!(false)));
    let events = reply.told();
    assert!(events.contains(&"comment.asks primes PRI-1 ~ decision".to_string()), "{events:?}");
    assert!(events.contains(&"issue.assignee primes PRI-1 claude owner".to_string()), "{events:?}");
    assert_eq!(board.read(&id).await["assignee"], json!("owner"));
    let ask = reply.body["id"].as_i64().unwrap();
    let reply = api.post(&comments, json!({"body": "Bitmap"})).send().await;
    assert!(reply.told().contains(&"issue.assignee primes PRI-1 owner claude".to_string()), "{:?}", reply.told());
    assert_eq!(board.read(&id).await["assignee"], json!("claude"));
    assert_eq!(api.get(&format!("{comments}/{ask}")).send().await.body["answered"], json!(true));
}

#[tokio::test]
async fn with_people_an_agents_question_waits_on_its_own_person_and_only_on_their_issue() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let claudes = board.assigned("Sieve", "claude").await;
    let bos = board.assigned("Wheel", "bo").await;
    // `claude` is the owner's, so it isn't ana's: her agent's ask leaves it be, as it does bo's.
    let reply = api.post(&format!("{}/comments", board.at(&claudes)), json!({"body": "?", "asks": "feedback"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 201);
    assert_eq!(board.read(&claudes).await["assignee"], json!("claude"));
    let reply = api.post(&format!("{}/comments", board.at(&bos)), json!({"body": "?", "asks": "decision"})).agent_of("ana").send().await;
    assert_eq!(reply.status, 201);
    assert_eq!(board.read(&bos).await["assignee"], json!("bo"));
    // On its person's own, the issue stays with them, not the owner.
    let anas = board.assigned("Factor", "ana").await;
    api.post(&format!("{}/comments", board.at(&anas)), json!({"body": "?", "asks": "decision"})).agent_of("ana").send().await;
    assert_eq!(board.read(&anas).await["assignee"], json!("ana"));
}

#[tokio::test]
async fn the_owner_edits_their_comment_and_the_new_words_are_carried() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let n = api.post(&format!("{}/comments", board.at(&id)), json!({"body": "Use a bitmap"})).send().await.body["id"].as_i64().unwrap();
    let at = format!("{}/comments/{n}", board.at(&id));
    let reply = api.patch(&at, json!({"body": "Use a wheel", "asks": "feedback"})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!((&reply.body["body"], &reply.body["asks"]), (&json!("Use a wheel"), &json!("feedback")));
    assert_eq!(reply.said("orrery-carry"), [format!("primes PRI-1 {n} edited")]);
    assert_eq!(reply.header("orrery-changed"), Some("primes"));
    let reply = api.patch(&at, json!({"asks": null})).send().await;
    assert_eq!((reply.body.get("asks"), reply.header("orrery-carry")), (None, None), "the same words aren't carried again");
    let reply = api.patch(&at, json!({"body": ""})).send().await;
    assert_eq!(reply.status, 400);
    assert_eq!(api.patch(&format!("{}/comments/99", board.at(&id)), json!({"body": "x"})).send().await.status, 404);
}

#[tokio::test]
async fn an_agent_cant_edit_or_delete_the_owners_comment() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let n = api.post(&format!("{}/comments", board.at(&id)), json!({"body": "Mine"})).send().await.body["id"].as_i64().unwrap();
    let at = format!("{}/comments/{n}", board.at(&id));
    let reply = api.patch(&at, json!({"body": "Theirs"})).by_agent("claude").send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (403, "Editing comment 1 is the owner's call: comment 1 was made by the owner"));
    let reply = api.delete(&at).by_agent("claude").send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (403, "Deleting comment 1 is the owner's call: comment 1 was made by the owner"));
    assert_eq!(board.comments(&id).await[0]["body"], json!("Mine"));
    // The owner deletes it.
    let reply = api.delete(&at).send().await;
    assert_eq!(reply.status, 204);
    assert!(board.comments(&id).await.is_empty());
}

#[tokio::test]
async fn a_members_words_are_theirs_and_their_agents_are_theirs_too() {
    let api = TestApi::new().await;
    api.team().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let comments = format!("{}/comments", board.at(&id));
    let reply = api.post(&comments, json!({"body": "Ana says"})).person("ana").send().await;
    assert_eq!(reply.said("orrery-carry").len(), 1, "a member's own words are carried to the session");
    let anas = format!("{comments}/{}", reply.body["id"]);
    let reply = api.patch(&anas, json!({"body": "Bo says"})).person("bo").send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (403, "Editing comment 1 is ana's call: they wrote it"));
    let reply = api.patch(&anas, json!({"body": "Ana says again"})).person("ana").send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.said("orrery-carry").len(), 1, "their own new words are carried");
    let reply = api.patch(&anas, json!({"body": "Tidied"})).send().await;
    assert_eq!((reply.status.as_u16(), reply.header("orrery-carry")), (200, None), "the owner may, but they aren't the owner's words");
    let reply = api.post(&comments, json!({"body": "Ana's agent says"})).agent_of("ana").send().await;
    let agents = format!("{comments}/{}", reply.body["id"]);
    let reply = api.delete(&agents).agent_of("bo").send().await;
    assert_eq!((reply.status.as_u16(), message(&reply)), (403, "Deleting comment 2 is ana's call: their agent wrote it"));
    let reply = api.delete(&agents).agent_of("ana").send().await;
    assert_eq!(reply.status, 204);
    assert_eq!(reply.header("orrery-changed"), Some("primes"));
    assert_eq!(api.get(&agents).send().await.status, 404);
    // A member's write names them in the outbox.
    let rows = api.outbox().await;
    let added = rows.iter().find(|row| row.kind == "comment.added").unwrap();
    assert_eq!(added.payload(), json!({"person": "ana"}));
}

#[tokio::test]
async fn the_activity_lists_who_changed_what_oldest_first() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    api.patch(&board.at(&id), json!({"priority": "P2"})).by_agent("claude").header("orrery-actor-session", "s1").send().await;
    api.patch(&board.at(&id), json!({"status": "todo"})).send().await;
    let activity = board.activity(&id).await;
    assert_eq!(activity.iter().map(|e| e["field"].as_str().unwrap()).collect::<Vec<_>>(), ["created", "priority", "status"]);
    assert_eq!((&activity[1]["created_by"], &activity[1]["session_name"], &activity[1]["protected"]), (&json!("claude"), &json!("s1"), &json!(false)));
    assert_eq!((&activity[2]["before"], &activity[2]["after"], &activity[2]["protected"]), (&json!("backlog"), &json!("todo"), &json!(true)));
    assert_eq!(activity[0]["issue"], json!(id));
}

#[tokio::test]
async fn orrerys_own_word_wakes_the_session_only_when_asked_and_open() {
    let api = TestApi::new().await;
    let board = Board::new(&api).await;
    let id = board.issue(json!({"title": "Sieve"})).await;
    let said = format!("{}/said", board.at(&id));
    let reply = api.post(&said, json!({"body": "#1 was merged into `main`.", "wakes": true})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let n = reply.body["id"].as_i64().unwrap();
    assert_eq!((&reply.body["created_by"], &reply.body["protected"]), (&json!("orrery"), &json!(false)));
    assert_eq!(reply.said("orrery-carry"), [format!("primes PRI-1 {n}")]);
    assert_eq!(reply.header("orrery-notice"), None, "orrery's own word rings no bell");
    assert_eq!(reply.told(), ["comment.added primes PRI-1"]);

    let note = api.post(&said, json!({"body": "Moved to Done."})).send().await;
    assert_eq!((note.status.as_u16(), note.header("orrery-carry")), (201, None), "a note wakes nobody");

    let closed = api.patch(&board.at(&id), json!({"status": "done"})).send().await;
    assert_eq!(closed.status, 200, "{}", closed.body);
    let late = api.post(&said, json!({"body": "#2 was merged.", "wakes": true})).send().await;
    assert_eq!((late.status.as_u16(), late.header("orrery-carry")), (201, None), "nor does news on a closed issue");
    assert_eq!(board.comments(&id).await.len(), 3);

    assert_eq!(api.post(&said, json!({"body": " "})).send().await.status, 400);
    assert_eq!(api.post(&said, json!({"body": "x", "wakes": "yes"})).send().await.status, 400);
    assert_eq!(api.post(&format!("{}/said", board.at("PRI-9")), json!({"body": "x"})).send().await.status, 404);
}

#[tokio::test]
async fn only_orrery_itself_says_things_as_orrery() {
    let api = TestApi::at_the_door().await;
    let project = api.project("Primes").await;
    let reply = api.post(&format!("/api/projects/{project}/issues/PRI-1/said"), json!({"body": "Merged."})).send().await;
    assert_eq!(reply.status, 403, "{}", reply.body);
}
