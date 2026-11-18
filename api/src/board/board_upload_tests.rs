// The tests of board_upload.rs (ORR-1142): a board's file, as `GET …/export` makes it, brought in again through
// `POST /api/boards`, as the local app sends it once it's checked the file.
use crate::testing::TestApi;
use serde_json::{json, Value};

/// A board's file for `project`, images and all, as its export makes it.
async fn exported(api: &TestApi, project: &str) -> Value {
    let reply = api.get(&format!("/api/projects/{project}/export?uploads=1")).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.body
}

/// What the local app sends for `file`, to be board `id` with key `key`, held by sam.
fn sent(file: &Value, id: &str, key: &str) -> Value {
    json!({"id": id, "key": key, "holder": "sam", "project": file["project"], "exported_at": file["exported_at"],
        "statuses": file["statuses"], "people": file["people"], "uploads": file["uploads"], "tables": file["tables"]})
}

async fn primes(api: &TestApi) -> (String, Value) {
    api.owner().await;
    let project = api.project("Primes").await;
    let top = api.issue(&project, json!({"title": "Sieve", "assignee": "sam"})).await;
    api.issue(&project, json!({"title": "Bitmap", "parent": top})).await;
    let said = api.post(&format!("/api/projects/{project}/issues/{top}/comments"), json!({"body": "Halfway"})).send().await;
    assert_eq!(said.status, 201, "{}", said.body);
    let file = exported(api, &project).await;
    (project, file)
}

#[tokio::test]
async fn a_boards_file_comes_in_as_a_new_board_held_by_its_uploader() {
    let api = TestApi::new().await;
    let (_, file) = primes(&api).await;
    let reply = api.post("/api/boards", sent(&file, "copy", "CPY")).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!((&reply.body["id"], &reply.body["key"], &reply.body["name"]), (&json!("copy"), &json!("CPY"), &json!("Primes")));
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE project = 'copy'").await, 2);
    assert_eq!(
        api.count("SELECT count(*) FROM issues WHERE project = 'copy' AND id = 'PRI-2' AND parent = 'PRI-1'").await,
        1,
        "the sub-issue keeps its parent"
    );
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE project = 'copy' AND assignee = 'sam'").await, 1, "a person here by name keeps theirs");
    assert_eq!(api.count("SELECT count(*) FROM project_members WHERE project = 'copy' AND person = 'sam' AND role = 'owner'").await, 1);
    // The file's comments are the file's, asking nothing of anyone, and numbered here.
    assert_eq!(api.count("SELECT count(*) FROM comments WHERE project = 'copy' AND created_by LIKE '% (from a file)' AND cleared = 1").await, 1);
    assert_eq!(api.count("SELECT count(*) FROM comments").await, 2);
    // Its history says where it came from, and its next issue comes after the file's.
    assert_eq!(api.count("SELECT count(*) FROM issue_events WHERE project = 'copy' AND field = 'uploaded'").await, 2);
    assert_eq!(api.count("SELECT count(*) FROM projects WHERE id = 'copy' AND next_number = 3 AND repo IS NULL").await, 1);
    assert!(api.outbox().await.iter().any(|change| change.kind == "project.changed" && change.project.as_deref() == Some("copy")));
}

#[tokio::test]
async fn an_id_or_key_taken_is_a_409_and_a_bad_one_a_400_and_nothing_is_made() {
    let api = TestApi::new().await;
    let (project, file) = primes(&api).await;
    let reply = api.post("/api/boards", sent(&file, &project, "CPY")).send().await;
    assert_eq!((reply.status.as_u16(), reply.body["message"].as_str()), (409, Some("There is already a project \"primes\": choose another id")));
    let reply = api.post("/api/boards", sent(&file, "copy", "PRI")).send().await;
    assert_eq!((reply.status.as_u16(), reply.body["message"].as_str()), (409, Some("There is already a project with the key PRI: choose another")));
    for (id, key) in [("Copy!", "CPY"), ("copy", "MLS"), ("copy", "cpy")] {
        assert_eq!(api.post("/api/boards", sent(&file, id, key)).send().await.status, 400, "{id} {key}");
    }
    assert_eq!(api.count("SELECT count(*) FROM projects").await, 1);
}

#[tokio::test]
async fn a_failure_partway_leaves_nothing_behind() {
    let api = TestApi::new().await;
    let (_, mut file) = primes(&api).await;
    // An issue its own parent's parent: refused once the project row is written.
    let top = file["tables"]["issues"].as_array_mut().unwrap().iter_mut().find(|issue| issue["id"] == "PRI-1").unwrap();
    top["parent"] = json!("PRI-2");
    let reply = api.post("/api/boards", sent(&file, "copy", "CPY")).send().await;
    assert_eq!(reply.status, 400, "{}", reply.body);
    assert!(reply.body["message"].as_str().unwrap_or_default().ends_with("is its own parent"), "{}", reply.body);
    assert_eq!(api.count("SELECT count(*) FROM projects WHERE id = 'copy'").await, 0);
    assert_eq!(api.count("SELECT count(*) FROM project_members WHERE project = 'copy'").await, 0);
}

#[tokio::test]
async fn statuses_go_by_id_else_their_kind_and_nobody_here_leaves_an_open_issue_unassigned() {
    let api = TestApi::new().await;
    let (_, mut file) = primes(&api).await;
    for issue in file["tables"]["issues"].as_array_mut().unwrap() {
        if issue["id"] == "PRI-1" {
            issue["status"] = json!("shipped");
        }
        issue["assignee"] = json!("someone-else");
    }
    file["statuses"] = json!([{"id": "shipped", "name": "Shipped", "kind": "done"}]);
    let reply = api.post("/api/boards", sent(&file, "copy", "CPY")).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE project = 'copy' AND id = 'PRI-1' AND status = 'done' AND assignee = 'someone-else'").await, 1);
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE project = 'copy' AND id = 'PRI-2' AND assignee IS NULL").await, 1);
}

#[tokio::test]
async fn an_image_that_isnt_one_is_refused() {
    let api = TestApi::new().await;
    let (_, file) = primes(&api).await;
    let mut body = sent(&file, "copy", "CPY");
    body["uploads"] = json!([{"id": "0123456789abcdef01234567", "data": "bm90IGFuIGltYWdl"}]);
    let reply = api.post("/api/boards", body.clone()).send().await;
    assert_eq!(reply.status, 400, "{}", reply.body);
    // A PNG's is kept, and one already here by that id stays as it is.
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    body["uploads"] = json!([{"id": "0123456789abcdef01234567", "data": png, "name": "dot.png"}]);
    assert_eq!(api.post("/api/boards", body).send().await.status, 201);
    assert_eq!(api.count("SELECT count(*) FROM uploads WHERE id = '0123456789abcdef01234567' AND type = 'image/png'").await, 1);
}

/// A board comes into the workspace the page was in (ORR-1195), and only one its uploader is in; its images do too
/// (ORR-1226).
#[tokio::test]
async fn a_board_comes_into_its_uploaders_workspace() {
    let api = TestApi::new().await;
    let (_, file) = primes(&api).await;
    api.acme(&["sam"]).await;
    let mut body = sent(&file, "copy", "CPY");
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    body["uploads"] = json!([{"id": "0123456789abcdef01234567", "data": png, "name": "dot.png"}]);
    let reply = api.post("/api/boards", body).header("orrery-workspace", "acme").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(api.count("SELECT count(*) FROM projects WHERE id = 'copy' AND workspace = 'acme'").await, 1);
    assert_eq!(api.count("SELECT count(*) FROM uploads WHERE id = '0123456789abcdef01234567' AND workspace = 'acme'").await, 1);
    sqlx::query("DELETE FROM workspace_members WHERE workspace = 'acme'").execute(&api.app.pool).await.unwrap();
    let refused = api.post("/api/boards", sent(&file, "other", "OTH")).header("orrery-workspace", "acme").send().await;
    assert_eq!(refused.status, 404, "sam isn't in Acme now: {}", refused.body);
}

/// Into another workspace, a board takes that workspace's statuses alone (ORR-1110): by id, else by name, else by kind.
#[tokio::test]
async fn a_board_in_another_workspace_takes_its_statuses_by_name_then_kind() {
    let api = TestApi::new().await;
    let (_, mut file) = primes(&api).await;
    api.acme(&["sam"]).await;
    for (id, name, kind, position) in
        [("acme-todo", "To do", "todo", "0"), ("acme-review", "In review", "started", "1"), ("acme-doing", "Doing", "started", "2")]
    {
        // The position goes in the statement, as Postgres won't take text into its number column.
        let statement = format!("INSERT INTO statuses (id, name, kind, color, position, workspace) VALUES (?, ?, ?, 'slate', {position}, 'acme')");
        api.run(&statement, &[id, name, kind]).await;
    }
    for issue in file["tables"]["issues"].as_array_mut().unwrap() {
        issue["status"] = json!(if issue["id"] == "PRI-1" { "review" } else { "doing-it" });
    }
    file["statuses"] = json!([{"id": "review", "name": "In Review", "kind": "started"}, {"id": "doing-it", "name": "Busy", "kind": "started"}]);
    let reply = api.post("/api/boards", sent(&file, "copy", "CPY")).header("orrery-workspace", "acme").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE project = 'copy' AND id = 'PRI-1' AND status = 'acme-review'").await, 1, "by name");
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE project = 'copy' AND id = 'PRI-2' AND status = 'acme-review'").await, 1, "the first of its kind");
    // A status the file doesn't describe, orrery's own `todo`, goes by its kind.
    let mut file = file;
    file["tables"]["schedules"] = json!([{"id": 9, "project": "primes", "title": "Groom", "cron": "0 9 * * 1", "timezone": "UTC", "place": "todo", "labels": "[]", "presets": "[]", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}]);
    let reply = api.post("/api/boards", sent(&file, "copy2", "CPZ")).header("orrery-workspace", "acme").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(api.count("SELECT count(*) FROM schedules WHERE project = 'copy2' AND place = 'acme-todo' AND enabled = 0").await, 1);
}

/// The owner bringing in a board of their own from another orrery (`own`, ORR-1110) keeps who said what and the
/// project's prompts; anyone else asking for it is refused.
#[tokio::test]
async fn the_owners_own_board_keeps_who_said_what_and_its_prompts() {
    let api = TestApi::new().await;
    let (project, _) = primes(&api).await;
    api.run("UPDATE projects SET focus_prompt = 'Mind the sieve', repo = 'https://example.com/primes' WHERE id = ?", &[&project]).await;
    api.run("UPDATE comments SET created_by = 'claude', session_name = 'primes · Ada', asks = 'decision', cleared = 0", &[]).await;
    let file = exported(&api, &project).await;
    let mut body = sent(&file, "copy", "CPY");
    body["own"] = json!(true);
    let refused = api.post("/api/boards", body.clone()).by_agent("sam").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    let reply = api.post("/api/boards", body).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(
        api.count("SELECT count(*) FROM comments WHERE project = 'copy' AND created_by = 'claude' AND session_name = 'primes · Ada' AND asks = 'decision' AND cleared = 0").await,
        1
    );
    assert_eq!(
        api.count("SELECT count(*) FROM projects WHERE id = 'copy' AND focus_prompt = 'Mind the sieve' AND repo = 'https://example.com/primes'").await,
        1
    );
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE project = 'copy' AND claimed_by IS NOT NULL").await, 0, "claims stay behind");
}

#[tokio::test]
async fn a_file_from_a_board_marked_as_moved_comes_in_unmarked() {
    let api = TestApi::new().await;
    let (project, _) = primes(&api).await;
    let marked = api.put(&format!("/api/projects/{project}/moved"), json!({"to": "https://orrery.example.com"})).send().await;
    assert_eq!(marked.status, 200, "{}", marked.body);
    let file = exported(&api, &project).await;
    assert_eq!(file["tables"]["projects"][0]["moved_to"], "https://orrery.example.com", "the file holds the row whole");
    let reply = api.post("/api/boards", sent(&file, "copy", "CPY")).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert!(reply.body.get("moved_to").is_none(), "{}", reply.body);
    let wrote = api.post("/api/projects/copy/issues", json!({"title": "Here now"})).agent_of_nobody().send().await;
    assert_eq!(wrote.status, 201, "{}", wrote.body);
}

// Holding an uploaded board out of pick lists (ORR-1224).

#[tokio::test]
async fn an_uploaded_board_starts_held_out_of_pick_lists_even_the_owners_own() {
    let api = TestApi::new().await;
    let (project, file) = primes(&api).await;
    assert!(api.get(&format!("/api/projects/{project}")).send().await.body.get("picks_held").is_none(), "a board made here isn't held");
    let reply = api.post("/api/boards", sent(&file, "copy", "CPY")).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert!(reply.body["picks_held"].is_string(), "{}", reply.body);
    let mut own = sent(&file, "ours", "OUR");
    own["own"] = json!(true);
    let own = api.post("/api/boards", own).send().await;
    assert_eq!(own.status, 201, "{}", own.body);
    assert!(own.body["picks_held"].is_string(), "the owner's own file is still a file: {}", own.body);
    let listed = api.get("/api/projects").send().await;
    let copy = listed.body.as_array().unwrap().iter().find(|p| p["id"] == "copy").cloned().unwrap();
    assert!(copy["picks_held"].is_string(), "the list says so too: {copy}");
}

#[tokio::test]
async fn only_the_owner_lets_sessions_pick_from_an_uploaded_board_and_its_logged() {
    let api = TestApi::new().await;
    let (_, file) = primes(&api).await;
    let made = api.post("/api/boards", sent(&file, "copy", "CPY")).send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    let at = "/api/projects/copy/picks-held";
    let agent = api.delete(at).agent_of_nobody().send().await;
    assert_eq!(agent.status, 403, "{}", agent.body);
    let owners_session = api.delete(at).header("orrery-actor-session", "s-1").send().await;
    assert_eq!(owners_session.status, 403, "a session naming the owner isn't the owner's page: {}", owners_session.body);
    let chat = api.delete(at).header("orrery-actor-kind", "chat").header("orrery-actor-asked", "1").send().await;
    assert_eq!(chat.status, 403, "{}", chat.body);
    assert_eq!(api.count("SELECT count(*) FROM projects WHERE id = 'copy' AND picks_held IS NOT NULL").await, 1, "still held");
    assert_eq!(api.delete("/api/projects/nowhere/picks-held").send().await.status, 404);

    let let_ = api.delete(at).header("orrery-actor-asked", "1").send().await;
    assert_eq!(let_.status, 200, "{}", let_.body);
    assert!(let_.body.get("picks_held").is_none(), "{}", let_.body);
    assert_eq!(let_.changed(), ["copy"], "open pages hear it");
    assert_eq!(api.count("SELECT count(*) FROM events WHERE kind = 'project.picks_let' AND project = 'copy'").await, 1, "it's logged");
    // Again, it's already let: nothing changes and nothing more is logged.
    let again = api.delete(at).header("orrery-actor-asked", "1").send().await;
    assert_eq!(again.status, 200, "{}", again.body);
    assert_eq!(api.count("SELECT count(*) FROM events WHERE kind = 'project.picks_let'").await, 1);
}

/// A board brought in tells no session about the comments it brings (ORR-1253): the owner's own keeps their comments as
/// theirs, which a session connecting would otherwise catch up on as unheard, since the signals that heard them stayed behind.
#[tokio::test]
async fn an_uploaded_boards_comments_are_no_sessions_to_catch_up_on() {
    let api = TestApi::new().await;
    let (project, _) = primes(&api).await;
    api.run("UPDATE comments SET owned = 1, created_by = 'owner'", &[]).await;
    let unanswered = |project: &str| api.get(&format!("/api/projects/{project}/comments/unanswered"));
    let waiting = unanswered(&project).send().await;
    assert_eq!(waiting.body.as_array().map(Vec::len), Some(1), "the source still waits on it: {}", waiting.body);
    let file = exported(&api, &project).await;
    let mut body = sent(&file, "copy", "CPY");
    body["own"] = json!(true);
    let reply = api.post("/api/boards", body).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(api.count("SELECT count(*) FROM comments WHERE project = 'copy' AND owned = 1 AND created_by = 'owner'").await, 1);
    assert_eq!(api.count("SELECT count(*) FROM signals WHERE project = 'copy'").await, 0, "nothing is signalled");
    assert_eq!(unanswered("copy").send().await.body, json!([]));
    // The owner's word on it after it came in is news again.
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    api.run(
        "INSERT INTO comments (project, issue, body, created_by, owned, by_agent, created_at, updated_at) VALUES ('copy', 'PRI-1', 'Carry on', 'owner', 1, 0, ?, ?)",
        &[&now, &now],
    )
    .await;
    let bodies = unanswered("copy").send().await.body;
    assert_eq!(bodies.as_array().unwrap().iter().map(|c| c["body"].as_str().unwrap()).collect::<Vec<_>>(), ["Carry on"]);
}

/// A board too big for one request comes in parts (ORR-1257): the board first, then the rest of its file `into` it, its
/// comments and events, which tell no session anything, as the whole board's don't.
#[tokio::test]
async fn the_rest_of_a_big_board_comes_into_it_after_it() {
    let api = TestApi::new().await;
    let (project, _) = primes(&api).await;
    api.run("UPDATE comments SET owned = 1, created_by = 'owner'", &[]).await;
    let file = exported(&api, &project).await;
    let mut first = sent(&file, "copy", "CPY");
    first["own"] = json!(true);
    let later = ["comments", "milestone_comments", "issue_events", "doc_revisions"];
    for table in later {
        first["tables"][table] = json!([]);
    }
    let made = api.post("/api/boards", first).send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    assert_eq!(api.count("SELECT count(*) FROM comments WHERE project = 'copy'").await, 0);

    let mut rest = json!({"id": "copy", "key": "CPY", "holder": "sam", "own": true, "into": true, "people": file["people"],
        "tables": {"projects": file["tables"]["projects"]}});
    for table in later {
        rest["tables"][table] = file["tables"][table].clone();
    }
    // Only what nothing else points at comes after the board, and only into a board its holder holds.
    // The web's check sends every table, the empty ones too, which are fine.
    rest["tables"]["issues"] = json!([]);
    let mut issues = rest.clone();
    issues["tables"]["issues"] = file["tables"]["issues"].clone();
    assert_eq!(api.post("/api/boards", issues).send().await.status, 400);
    let mut theirs = rest.clone();
    theirs["holder"] = json!("ada");
    assert_eq!(api.post("/api/boards", theirs).send().await.status, 404);
    let mut nowhere = rest.clone();
    nowhere["id"] = json!("nowhere");
    assert_eq!(api.post("/api/boards", nowhere).send().await.status, 404);

    let added = api.post("/api/boards", rest).send().await;
    assert_eq!(added.status, 200, "{}", added.body);
    assert_eq!(api.count("SELECT count(*) FROM comments WHERE project = 'copy' AND owned = 1 AND created_by = 'owner'").await, 1);
    let events = api.count(&format!("SELECT count(*) FROM issue_events WHERE project = '{project}'")).await;
    assert_eq!(api.count("SELECT count(*) FROM issue_events WHERE project = 'copy' AND field <> 'uploaded'").await, events);
    assert_eq!(api.count("SELECT count(*) FROM signals WHERE project = 'copy'").await, 0, "nothing is signalled");
    assert_eq!(api.get("/api/projects/copy/comments/unanswered").send().await.body, json!([]));
}
