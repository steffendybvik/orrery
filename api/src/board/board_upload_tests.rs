// The tests of board_upload.rs (ORR-1142): a board's file, as `GET …/export` makes it, brought in again through
// `POST /api/boards`, as the local app sends it once it's checked the file.
use crate::testing::TestApi;
use serde_json::{json, Value};

/// A board's file for `project`, as its export makes it.
async fn exported(api: &TestApi, project: &str) -> Value {
    let reply = api.get(&format!("/api/projects/{project}/export")).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    reply.body
}

/// What the local app sends for `file`, to be board `id` with key `key`, held by steffen.
fn sent(file: &Value, id: &str, key: &str) -> Value {
    json!({"id": id, "key": key, "holder": "steffen", "project": file["project"], "exported_at": file["exported_at"],
        "statuses": file["statuses"], "people": file["people"], "uploads": file["uploads"], "tables": file["tables"]})
}

async fn primes(api: &TestApi) -> (String, Value) {
    api.owner().await;
    let project = api.project("Primes").await;
    let top = api.issue(&project, json!({"title": "Sieve", "assignee": "steffen"})).await;
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
    assert_eq!(api.count("SELECT count(*) FROM issues WHERE project = 'copy' AND assignee = 'steffen'").await, 1, "a person here by name keeps theirs");
    assert_eq!(api.count("SELECT count(*) FROM project_members WHERE project = 'copy' AND person = 'steffen' AND role = 'owner'").await, 1);
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
