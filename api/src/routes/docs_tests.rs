// The tests of routes/docs.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::{Reply, TestApi};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use sqlx::Row;

/// What a reply's `orrery-told` says, decoded: `doc.created primes plan`, each event in turn.
fn told(reply: &Reply) -> Vec<String> {
    reply.header("orrery-told").map(|t| t.split(", ").map(|e| percent_decode_str(e).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default()
}

/// The outbox's rows, oldest first, as `<kind> <project> <subject>`.
async fn outbox(api: &TestApi) -> Vec<String> {
    let rows = sqlx::query("SELECT kind, project, subject FROM changes ORDER BY id").fetch_all(&api.app.pool).await.unwrap();
    rows.iter()
        .map(|r| {
            let part = |key: &str| r.get::<Option<String>, _>(key).unwrap_or_default();
            format!("{} {} {}", part("kind"), part("project"), part("subject")).trim_end().to_string()
        })
        .collect()
}

async fn doc(api: &TestApi, project: &str, body: Value) -> Value {
    let reply = api.post(&format!("/api/projects/{project}/docs"), body).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    reply.body
}

fn problems(reply: &Reply) -> Vec<String> {
    reply.body["data"]["problems"].as_array().map(|p| p.iter().map(|p| p.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default()
}

#[tokio::test]
async fn a_new_doc_is_made_from_its_title_and_read_back() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let before = outbox(&api).await.len();
    let reply = api.post(&format!("/api/projects/{project}/docs"), json!({"title": "  The Plan ", "body": "Sieve first.\n\nThen more."})).send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["id"], "the-plan");
    assert_eq!(reply.body["project"], json!(project));
    assert_eq!(reply.body["title"], "The Plan");
    assert_eq!(reply.body["kind"], "markdown");
    assert_eq!(reply.body["body"], "Sieve first.\n\nThen more.");
    assert_eq!(reply.body["created_by"], "owner");
    assert_eq!(reply.body["protected"], true);
    assert!(reply.body["full_id"].as_str().unwrap().starts_with("doc-the-plan-"), "{}", reply.body);
    assert_eq!(reply.header("orrery-changed"), Some(project.as_str()));
    assert_eq!(told(&reply), vec![format!("doc.created {project} the-plan")]);
    assert_eq!(outbox(&api).await[before..], [format!("project.changed {project}"), format!("doc.created {project} the-plan")]);

    let read = api.get(&format!("/api/projects/{project}/docs/the-plan")).send().await;
    assert_eq!(read.status, 200);
    assert_eq!(read.body, reply.body);
    let listed = api.get(&format!("/api/projects/{project}/docs")).send().await;
    assert_eq!(listed.status, 200);
    assert_eq!(listed.body.as_array().unwrap().len(), 1);
    assert_eq!(listed.body[0]["id"], "the-plan");
    assert!(listed.body[0].get("body").is_none(), "a listed doc is its summary: {}", listed.body);
    assert!(listed.body[0].get("match").is_none());
}

#[tokio::test]
async fn a_doc_is_read_by_its_full_id_too() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let made = doc(&api, &project, json!({"title": "Plan"})).await;
    let full = made["full_id"].as_str().unwrap();
    let read = api.get(&format!("/api/projects/{project}/docs/{full}")).send().await;
    assert_eq!(read.status, 200, "{}", read.body);
    assert_eq!(read.body["id"], "plan");
}

#[tokio::test]
async fn a_second_doc_with_the_same_title_gets_a_numbered_id() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    assert_eq!(doc(&api, &project, json!({"title": "Plan"})).await["id"], "plan");
    assert_eq!(doc(&api, &project, json!({"title": "Plan"})).await["id"], "plan-2");
    assert_eq!(doc(&api, &project, json!({"title": "Plan"})).await["id"], "plan-3");
    // A title with nothing to slug is a `doc`.
    assert_eq!(doc(&api, &project, json!({"title": "!!!"})).await["id"], "doc");
}

#[tokio::test]
async fn a_doc_with_an_id_already_taken_is_a_conflict() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan", "id": "plan"})).await;
    let again = api.post(&format!("/api/projects/{project}/docs"), json!({"title": "Other", "id": "plan"})).send().await;
    assert_eq!(again.status, 409, "{}", again.body);
}

#[tokio::test]
async fn a_bad_doc_body_is_refused_with_each_problem() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let path = format!("/api/projects/{project}/docs");
    let reply = api.post(&path, json!({"title": " ", "kind": "pdf", "colour": "red", "position": "top", "id": "Not A Slug"})).send().await;
    assert_eq!(reply.status, 400);
    let found = problems(&reply);
    assert_eq!(found.len(), 5, "{found:?}");
    assert_eq!(reply.body["message"], "5 problems in the body");
    assert!(found.iter().any(|p| p.starts_with("unknown field \"colour\"")), "{found:?}");
    assert!(found.contains(&"\"title\" can't be empty".to_string()), "{found:?}");

    let missing = api.post(&path, json!({"body": "words"})).send().await;
    assert_eq!(missing.status, 400);
    assert_eq!(problems(&missing), ["missing \"title\""]);
    let not_object = api.post(&path, json!(["Plan"])).send().await;
    assert_eq!(not_object.status, 400);
    assert_eq!(api.get(&path).send().await.body, json!([]), "nothing was made");
}

#[tokio::test]
async fn docs_of_a_missing_project_or_a_missing_doc_are_not_found() {
    let api = TestApi::new().await;
    assert_eq!(api.get("/api/projects/nope/docs").send().await.status, 404);
    assert_eq!(api.post("/api/projects/nope/docs", json!({"title": "Plan"})).send().await.status, 404);
    assert_eq!(api.get("/api/projects/nope/deleted-docs").send().await.status, 404);
    assert_eq!(api.get("/api/projects/nope/doc-sections").send().await.status, 404);
    let project = api.project("Primes").await;
    for reply in [
        api.get(&format!("/api/projects/{project}/docs/nope")).send().await,
        api.patch(&format!("/api/projects/{project}/docs/nope"), json!({"body": "x"})).send().await,
        api.delete(&format!("/api/projects/{project}/docs/nope")).send().await,
        api.get(&format!("/api/projects/{project}/docs/nope/revisions")).send().await,
        api.get(&format!("/api/projects/{project}/docs/nope/revisions/1")).send().await,
        api.post(&format!("/api/projects/{project}/docs/nope/revisions/1/restore"), json!({})).send().await,
    ] {
        assert_eq!(reply.status, 404, "{}", reply.body);
    }
}

#[tokio::test]
async fn the_list_finds_words_in_titles_and_bodies_with_title_matches_first() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Notes", "body": "All about gears and wheels."})).await;
    doc(&api, &project, json!({"title": "Gears", "body": "Teeth."})).await;
    doc(&api, &project, json!({"title": "Axles", "body": "Nothing here."})).await;
    let all = api.get(&format!("/api/projects/{project}/docs")).send().await.body;
    let ids: Vec<&str> = all.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["axles", "gears", "notes"], "A to Z without a search");
    let found = api.get(&format!("/api/projects/{project}/docs?q=GEARS")).send().await.body;
    let ids: Vec<&str> = found.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["gears", "notes"]);
    assert!(found[1]["match"].as_str().unwrap().contains("gears"), "{found}");
    let none = api.get(&format!("/api/projects/{project}/docs?q=gears%20sprockets")).send().await.body;
    assert_eq!(none, json!([]), "every word has to be there");
}

#[tokio::test]
async fn changing_a_doc_s_text_keeps_a_revision_and_tells_it_changed() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan", "body": "One."})).await;
    let path = format!("/api/projects/{project}/docs/plan");
    let reply = api.patch(&path, json!({"body": "Two.", "title": " Plan B "})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["body"], "Two.");
    assert_eq!(reply.body["title"], "Plan B");
    assert_eq!(reply.body["id"], "plan", "the id stays");
    assert_eq!(told(&reply), [format!("doc.changed {project} plan")]);
    assert_eq!(reply.header("orrery-changed"), Some(project.as_str()));
    let revisions = api.get(&format!("{path}/revisions")).send().await;
    assert_eq!(revisions.status, 200);
    let list = revisions.body.as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["title"], "Plan B", "newest first");
    assert_eq!(list[1]["title"], "Plan");
    assert_eq!(list[0]["deleted"], false);
    assert!(list[0].get("body").is_none(), "listed revisions leave the text out");

    // The same text saved again is no new revision.
    api.patch(&path, json!({"body": "Two."})).send().await;
    assert_eq!(api.get(&format!("{path}/revisions")).send().await.body.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn filing_a_doc_in_a_section_is_no_revision_and_tells_nothing() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan"})).await;
    let path = format!("/api/projects/{project}/docs/plan");
    let reply = api.patch(&path, json!({"section": "  Guides  "})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["section"], "Guides");
    assert_eq!(reply.header("orrery-told"), None);
    assert_eq!(reply.header("orrery-changed"), Some(project.as_str()));
    assert_eq!(api.get(&format!("{path}/revisions")).send().await.body.as_array().unwrap().len(), 1);
    assert_eq!(api.get(&format!("/api/projects/{project}/doc-sections")).send().await.body, json!(["Guides"]));
    // A null section takes it out again.
    let out = api.patch(&path, json!({"section": null})).send().await;
    assert_eq!(out.status, 200);
    assert!(out.body.get("section").is_none(), "{}", out.body);
}

#[tokio::test]
async fn a_doc_s_id_and_kind_do_not_change() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan"})).await;
    let path = format!("/api/projects/{project}/docs/plan");
    let id = api.patch(&path, json!({"id": "other"})).send().await;
    assert_eq!(id.status, 400);
    assert_eq!(id.body["message"], "A doc's id can't change");
    let kind = api.patch(&path, json!({"kind": "artifact"})).send().await;
    assert_eq!(kind.status, 400);
    assert_eq!(api.patch(&path, json!({"kind": "markdown", "id": "plan"})).send().await.status, 200, "the same ones are fine");
    assert_eq!(api.patch(&path, json!({"title": null})).send().await.status, 400);
}

#[tokio::test]
async fn put_makes_the_doc_at_its_id_then_replaces_its_text() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let path = format!("/api/projects/{project}/docs/readme");
    let made = api.put(&path, json!({"title": "Readme", "body": "First.", "section": "Repo"})).send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    assert_eq!(made.body["id"], "readme");
    assert_eq!(told(&made), [format!("doc.created {project} readme")]);
    let replaced = api.put(&path, json!({"title": "Readme", "body": "Second."})).send().await;
    assert_eq!(replaced.status, 200, "{}", replaced.body);
    assert_eq!(replaced.body["body"], "Second.");
    assert_eq!(replaced.body["section"], "Repo", "a section left out keeps the one it has");
    assert_eq!(told(&replaced), [format!("doc.changed {project} readme")]);
    // Left out, the text is emptied: the file is the whole doc.
    let emptied = api.put(&path, json!({"title": "Readme"})).send().await;
    assert_eq!(emptied.body["body"], "");
}

#[tokio::test]
async fn put_refuses_an_id_it_cannot_make() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let base = format!("/api/projects/{project}/docs");
    let not_slug = api.put(&format!("{base}/Read_Me"), json!({"title": "Readme"})).send().await;
    assert_eq!(not_slug.status, 400, "{}", not_slug.body);
    let other = api.put(&format!("{base}/readme"), json!({"title": "Readme", "id": "other"})).send().await;
    assert_eq!(other.status, 400, "{}", other.body);
    let untitled = api.put(&format!("{base}/readme"), json!({"body": "x"})).send().await;
    assert_eq!(untitled.status, 400);
    assert_eq!(problems(&untitled), ["missing \"title\""]);
    // Another board's full id isn't a doc to make here.
    let foreign = api.put(&format!("{base}/doc-readme-abcdefgh"), json!({"title": "Readme"})).send().await;
    assert_eq!(foreign.status, 404, "{}", foreign.body);
    assert_eq!(api.get(&base).send().await.body, json!([]));
}

#[tokio::test]
async fn a_deleted_doc_is_listed_as_deleted_and_can_be_restored() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan", "body": "Keep me.", "section": "Guides"})).await;
    let path = format!("/api/projects/{project}/docs/plan");
    let gone = api.delete(&path).send().await;
    assert_eq!(gone.status, 204);
    assert_eq!(gone.body, Value::Null);
    assert_eq!(told(&gone), [format!("doc.deleted {project} plan")]);
    assert_eq!(api.get(&path).send().await.status, 404);

    let deleted = api.get(&format!("/api/projects/{project}/deleted-docs")).send().await;
    assert_eq!(deleted.status, 200);
    assert_eq!(deleted.body.as_array().unwrap().len(), 1);
    assert_eq!(deleted.body[0]["id"], "plan");
    assert_eq!(deleted.body[0]["deleted_by"], "owner");
    let revisions = api.get(&format!("{path}/revisions")).send().await.body;
    assert_eq!(revisions[0]["deleted"], true, "{revisions}");
    let kept = revisions[1]["id"].as_i64().unwrap();
    let read = api.get(&format!("{path}/revisions/{kept}")).send().await;
    assert_eq!(read.status, 200);
    assert_eq!(read.body["body"], "Keep me.");
    assert_eq!(read.body["doc"], "plan");

    let back = api.post(&format!("{path}/revisions/{kept}/restore"), json!({})).send().await;
    assert_eq!(back.status, 201, "{}", back.body);
    assert_eq!(back.body["body"], "Keep me.");
    assert_eq!(back.body["section"], "Guides", "it comes back where it was filed");
    assert_eq!(back.body["protected"], true, "and stays the owner's");
    assert_eq!(told(&back), [format!("doc.created {project} plan")]);
    assert_eq!(api.get(&format!("/api/projects/{project}/deleted-docs")).send().await.body, json!([]));
}

#[tokio::test]
async fn restoring_an_older_revision_of_a_live_doc_puts_its_text_back() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan", "body": "One."})).await;
    let path = format!("/api/projects/{project}/docs/plan");
    api.patch(&path, json!({"body": "Two."})).send().await;
    let revisions = api.get(&format!("{path}/revisions")).send().await.body;
    let (newest, oldest) = (revisions[0]["id"].as_i64().unwrap(), revisions[1]["id"].as_i64().unwrap());

    let same = api.post(&format!("{path}/revisions/{newest}/restore"), json!({})).send().await;
    assert_eq!(same.status, 200);
    assert_eq!(same.header("orrery-told"), None, "the text it has already is no change");

    let back = api.post(&format!("{path}/revisions/{oldest}/restore"), json!({})).send().await;
    assert_eq!(back.status, 200, "{}", back.body);
    assert_eq!(back.body["body"], "One.");
    assert_eq!(told(&back), [format!("doc.changed {project} plan")]);
    assert_eq!(api.get(&format!("{path}/revisions")).send().await.body.as_array().unwrap().len(), 3, "a restore is a revision to undo too");
}

#[tokio::test]
async fn a_revision_of_another_kind_cannot_be_restored_over_a_live_doc() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Page", "id": "page", "kind": "artifact", "body": "<p>hi</p>"})).await;
    let path = format!("/api/projects/{project}/docs/page");
    let first = api.get(&format!("{path}/revisions")).send().await.body[0]["id"].as_i64().unwrap();
    api.delete(&path).send().await;
    doc(&api, &project, json!({"title": "Page", "id": "page", "body": "words"})).await;
    let reply = api.post(&format!("{path}/revisions/{first}/restore"), json!({})).send().await;
    assert_eq!(reply.status, 409, "{}", reply.body);
}

#[tokio::test]
async fn a_revision_that_is_not_one_is_not_found() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan"})).await;
    for revision in ["999", "0", "-1", "abc", "99999999999"] {
        let reply = api.get(&format!("/api/projects/{project}/docs/plan/revisions/{revision}")).send().await;
        assert_eq!(reply.status, 404, "revision {revision}: {}", reply.body);
    }
}

#[tokio::test]
async fn an_agent_deletes_its_own_docs_but_not_the_owner_s() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Owned"})).await;
    let path = format!("/api/projects/{project}/docs");
    let refused = api.delete(&format!("{path}/owned")).by_agent("claude").send().await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(refused.body["data"]["permission"], "issues.delete");
    assert_eq!(api.get(&format!("{path}/owned")).send().await.status, 200, "it's still there");

    let theirs = api.post(&path, json!({"title": "Scratch"})).by_agent("claude").send().await;
    assert_eq!(theirs.status, 201);
    assert_eq!(theirs.body["created_by"], "claude");
    assert_eq!(theirs.body["protected"], false);
    // An agent changes the owner's doc all the same: only deleting it is the owner's.
    assert_eq!(api.patch(&format!("{path}/owned"), json!({"body": "edited"})).by_agent("claude").send().await.status, 200);
    assert_eq!(api.delete(&format!("{path}/scratch")).by_agent("claude").send().await.status, 204);
    let deleted = api.get(&format!("/api/projects/{project}/deleted-docs")).send().await.body;
    assert_eq!(deleted[0]["deleted_by"], "claude");
}

#[tokio::test]
async fn a_section_is_made_listed_last_and_refused_twice() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let path = format!("/api/projects/{project}/doc-sections");
    let made = api.post(&path, json!({"name": "  Zebra "})).send().await;
    assert_eq!(made.status, 201, "{}", made.body);
    assert_eq!(made.body, json!({"name": "Zebra"}));
    assert_eq!(made.header("orrery-changed"), Some(project.as_str()));
    api.post(&path, json!({"name": "Apple"})).send().await;
    assert_eq!(api.get(&path).send().await.body, json!(["Zebra", "Apple"]), "a new section goes at the end");
    assert_eq!(api.post(&path, json!({"name": "Apple"})).send().await.status, 409);
    for body in [json!({}), json!({"name": "  "}), json!({"name": 3})] {
        assert_eq!(api.post(&path, body.clone()).send().await.status, 400, "{body}");
    }
}

#[tokio::test]
async fn renaming_a_section_moves_its_docs_with_it() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan", "section": "Guides"})).await;
    api.post(&format!("/api/projects/{project}/doc-sections"), json!({"name": "Other"})).send().await;
    let path = format!("/api/projects/{project}/doc-sections");
    let renamed = api.patch(&format!("{path}/Guides"), json!({"name": "Handbook"})).send().await;
    assert_eq!(renamed.status, 200, "{}", renamed.body);
    assert_eq!(renamed.body, json!({"name": "Handbook"}));
    assert_eq!(api.get(&path).send().await.body, json!(["Handbook", "Other"]), "it keeps its place");
    assert_eq!(api.get(&format!("/api/projects/{project}/docs/plan")).send().await.body["section"], "Handbook");
    assert_eq!(api.patch(&format!("{path}/Handbook"), json!({"name": "Other"})).send().await.status, 409);
    assert_eq!(api.patch(&format!("{path}/Missing"), json!({"name": "New"})).send().await.status, 404);
    assert_eq!(api.patch(&format!("{path}/Handbook"), json!({"name": ""})).send().await.status, 400);
}

#[tokio::test]
async fn a_section_moves_to_where_its_position_says() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let path = format!("/api/projects/{project}/doc-sections");
    for name in ["A", "B", "C"] {
        api.post(&path, json!({"name": name})).send().await;
    }
    let moved = api.patch(&format!("{path}/C"), json!({"position": 0})).send().await;
    assert_eq!(moved.status, 200, "{}", moved.body);
    assert_eq!(api.get(&path).send().await.body, json!(["C", "A", "B"]));
    api.patch(&format!("{path}/C"), json!({"position": 99})).send().await;
    assert_eq!(api.get(&path).send().await.body, json!(["A", "B", "C"]), "past the end is the bottom");
    let both = api.patch(&format!("{path}/A"), json!({"name": "First", "position": 2})).send().await;
    assert_eq!(both.body, json!({"name": "First"}));
    assert_eq!(api.get(&path).send().await.body, json!(["B", "C", "First"]));
    for position in [json!(-1), json!(1.5), json!("top")] {
        assert_eq!(api.patch(&format!("{path}/B"), json!({"position": position})).send().await.status, 400, "{position}");
    }
}

#[tokio::test]
async fn deleting_a_section_keeps_its_docs_filed_under_none() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    doc(&api, &project, json!({"title": "Plan", "section": "Guides"})).await;
    let path = format!("/api/projects/{project}/doc-sections");
    let gone = api.delete(&format!("{path}/Guides")).send().await;
    assert_eq!(gone.status, 204);
    assert_eq!(gone.header("orrery-changed"), Some(project.as_str()));
    assert_eq!(api.get(&path).send().await.body, json!([]));
    let plan = api.get(&format!("/api/projects/{project}/docs/plan")).send().await;
    assert_eq!(plan.status, 200);
    assert!(plan.body.get("section").is_none(), "{}", plan.body);
    assert_eq!(api.delete(&format!("{path}/Guides")).send().await.status, 404);
}

#[tokio::test]
async fn a_numbered_id_still_fits_in_forty_characters() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let title = "A very long title that goes on well past the forty characters an id holds";
    let first = doc(&api, &project, json!({"title": title})).await["id"].as_str().unwrap().to_string();
    let second = doc(&api, &project, json!({"title": title})).await["id"].as_str().unwrap().to_string();
    assert!(first.len() <= 40, "{first}");
    assert!(second.len() <= 40 && second.ends_with("-2"), "{second}");
    assert_eq!(api.put(&format!("/api/projects/{project}/docs/{second}"), json!({"title": "Again"})).send().await.status, 200, "PUT takes it");
}

#[tokio::test]
async fn a_restored_doc_is_still_whoever_made_it() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let path = format!("/api/projects/{project}/docs");
    assert_eq!(api.post(&path, json!({"title": "Scratch", "body": "Notes."})).by_agent("claude").send().await.status, 201);
    assert_eq!(api.delete(&format!("{path}/scratch")).send().await.status, 204);
    let revision = api.get(&format!("/api/projects/{project}/deleted-docs")).send().await.body[0]["revision"].as_i64().unwrap();
    // The deletion's own revision holds the text as it was, so it restores too.
    let back = api.post(&format!("{path}/scratch/revisions/{revision}/restore"), json!({})).send().await;
    assert_eq!(back.status, 201, "{}", back.body);
    assert_eq!(back.body["created_by"], "claude");
    assert_eq!(back.body["protected"], false);
    assert_eq!(back.body["body"], "Notes.");
}

#[tokio::test]
async fn sections_are_listed_as_arranged_then_a_to_z() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let path = format!("/api/projects/{project}/doc-sections");
    for (title, section) in [("One", "Zeta"), ("Two", "Beta"), ("Three", "Alpha")] {
        doc(&api, &project, json!({"title": title, "section": section})).await;
    }
    assert_eq!(api.get(&path).send().await.body, json!(["Zeta", "Beta", "Alpha"]), "each new one at the end");
    // Those the arrangement leaves out go after it, A to Z.
    sqlx::query("UPDATE projects SET doc_section_order = ? WHERE id = ?").bind(r#"["Beta"]"#).bind(&project).execute(&api.app.pool).await.unwrap();
    assert_eq!(api.get(&path).send().await.body, json!(["Beta", "Alpha", "Zeta"]));
}
