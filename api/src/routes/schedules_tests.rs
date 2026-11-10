// The tests of routes/schedules.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::{json, Value};

/// Puts a schedule on `project` with SQL, as there's no write route here: a cron one by default, with `next_run`, and
/// `more` columns set as given (each value SQL). Gives back its id.
async fn schedule(api: &TestApi, project: &str, title: &str, next_run: Option<&str>, more: &[(&str, &str)]) -> i64 {
    let mut columns = vec!["project", "title", "timezone", "created_by", "created_at", "updated_at", "next_run"];
    let mut values = vec![
        format!("'{project}'"),
        format!("'{}'", title.replace('\'', "''")),
        "'Europe/Oslo'".into(),
        "'owner'".into(),
        "'2026-11-01T00:00:00.000Z'".into(),
        "'2026-11-02T00:00:00.000Z'".into(),
        next_run.map(|n| format!("'{n}'")).unwrap_or_else(|| "NULL".into()),
    ];
    if !more.iter().any(|(c, _)| ["cron", "at", "on_event"].contains(c)) {
        columns.push("cron");
        values.push("'0 9 * * 1'".into());
    }
    // One given again (`created_by`, say) takes the default's place: Postgres refuses a column named twice.
    for (column, value) in more {
        match columns.iter().position(|c| c == column) {
            Some(at) => values[at] = value.to_string(),
            None => {
                columns.push(column);
                values.push(value.to_string());
            }
        }
    }
    let query = format!("INSERT INTO schedules ({}) VALUES ({}) RETURNING id", columns.join(", "), values.join(", "));
    sqlx::query_scalar::<_, i64>(&query).fetch_one(&api.app.pool).await.unwrap()
}

async fn run(api: &TestApi, schedule: i64, at: &str, outcome: &str, issue: Option<&str>) {
    sqlx::query(&crate::db::sql("INSERT INTO schedule_runs (schedule, at, outcome, issue) VALUES (?, ?, ?, ?)"))
        .bind(schedule)
        .bind(at)
        .bind(outcome)
        .bind(issue)
        .execute(&api.app.pool)
        .await
        .unwrap();
}

fn titles(body: &Value) -> Vec<&str> {
    body.as_array().unwrap().iter().map(|s| s["title"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn a_project_with_no_schedules_lists_none() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let reply = api.get(&format!("/api/projects/{project}/schedules")).send().await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, json!([]));
    assert_eq!(api.get("/api/schedules").send().await.body, json!([]));
    assert_eq!(api.get("/api/schedules/across").send().await.body, json!([]));
}

#[tokio::test]
async fn a_project_it_doesnt_have_is_a_404() {
    let api = TestApi::new().await;
    let reply = api.get("/api/projects/nope/schedules").send().await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.body["message"], "No project \"nope\"");
}

#[tokio::test]
async fn a_schedule_reads_as_the_api_gives_it() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id =
        schedule(&api, &project, "Weekly review", Some("2026-11-09T08:00:00.000Z"), &[("notes", "'Look back'"), ("labels", "'[\"review\"]'"), ("owned", "1")])
            .await;
    let reply = api.get(&format!("/api/projects/{project}/schedules/{id}")).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let s = &reply.body;
    assert_eq!(s["id"], id);
    assert_eq!(s["project"], json!(project));
    assert_eq!(s["kind"], "issue");
    assert_eq!(s["title"], "Weekly review");
    assert_eq!(s["notes"], "Look back");
    assert_eq!(s["cron"], "0 9 * * 1");
    assert_eq!(s["timezone"], "Europe/Oslo");
    assert_eq!(s["column"], "todo");
    assert_eq!(s["labels"], json!(["review"]));
    assert_eq!(s["presets"], json!([]));
    assert_eq!(s["move_from"], json!([]));
    assert_eq!((s["ask"].as_bool(), s["skip_open"].as_bool(), s["enabled"].as_bool()), (Some(false), Some(true), Some(true)));
    assert_eq!(s["protected"], true);
    assert_eq!(s["next_run"], "2026-11-09T08:00:00.000Z");
    assert_eq!(s["runs"], json!([]));
    for gone in ["at", "on", "on_filter", "milestone", "priority", "held", "across", "model", "effort"] {
        assert!(s.get(gone).is_none(), "{gone} is left out when there's none: {s}");
    }
}

#[tokio::test]
async fn an_event_schedule_says_what_it_waits_on_and_its_model() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id = schedule(
        &api,
        &project,
        "On done",
        None,
        &[
            ("kind", "'session'"),
            ("on_event", "'issue.status'"),
            ("on_filter", "'{\"to\":\"done\"}'"),
            ("model", "'opus'"),
            ("effort", "''"),
            ("priority", "'P1'"),
        ],
    )
    .await;
    let s = api.get(&format!("/api/projects/{project}/schedules/{id}")).send().await.body;
    assert_eq!(s["kind"], "session");
    assert_eq!(s["on"], "issue.status");
    assert_eq!(s["on_filter"], json!({"to": "done"}));
    assert_eq!(s["model"], "opus");
    assert_eq!(s["priority"], "P1");
    assert!(s.get("effort").is_none(), "a blank effort is none");
    assert!(s.get("cron").is_none() && s.get("next_run").is_none());
}

#[tokio::test]
async fn a_schedule_comes_with_its_latest_ten_runs_newest_first_and_what_it_holds_back() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id = schedule(&api, &project, "Daily", None, &[]).await;
    for day in 1..=12 {
        run(&api, id, &format!("2026-10-{day:02}T09:00:00.000Z"), "made", Some(&format!("PRI-{day}"))).await;
    }
    sqlx::query(&crate::db::sql(
        "INSERT INTO schedule_held (schedule, subject, event, at) VALUES (?, 'PRI-1', '{}', '2026-11-01'), (?, 'PRI-2', '{}', '2026-11-01')",
    ))
    .bind(id)
    .bind(id)
    .execute(&api.app.pool)
    .await
    .unwrap();
    let s = api.get(&format!("/api/projects/{project}/schedules/{id}")).send().await.body;
    let runs = s["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 10);
    assert_eq!(runs[0], json!({"at": "2026-10-12T09:00:00.000Z", "outcome": "made", "issue": "PRI-12"}));
    assert_eq!(runs[9]["issue"], "PRI-3");
    assert_eq!(s["held"], 2);
}

#[tokio::test]
async fn a_schedule_by_its_full_id_on_this_server() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id = schedule(&api, &project, "Daily", None, &[]).await;
    sqlx::query("UPDATE settings SET value = '\"x7k2m9qd\"' WHERE key = 'uid'").execute(&api.app.pool).await.unwrap();
    let reply = api.get(&format!("/api/projects/{project}/schedules/sch-{id}-x7k2m9qd")).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["id"], id);
    let other = api.get(&format!("/api/projects/{project}/schedules/sch-{id}-aaaaaaaa")).send().await;
    assert_eq!(other.status, 404, "another server's id isn't this one's");
}

#[tokio::test]
async fn a_schedule_it_doesnt_have_is_a_404() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let other = api.project("Squares").await;
    let id = schedule(&api, &other, "Elsewhere", None, &[]).await;
    let reply = api.get(&format!("/api/projects/{project}/schedules/{id}")).send().await;
    assert_eq!(reply.status, 404, "another project's schedule isn't this one's");
    assert_eq!(reply.body["message"], format!("No schedule {id} in {project}"));
    assert_eq!(api.get(&format!("/api/projects/{project}/schedules/abc")).send().await.status, 404);
}

#[tokio::test]
async fn schedules_are_listed_soonest_first_then_by_title_with_no_next_run_last() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    schedule(&api, &project, "Never", None, &[]).await;
    schedule(&api, &project, "b later", Some("2026-11-10T00:00:00.000Z"), &[]).await;
    schedule(&api, &project, "A later", Some("2026-11-10T00:00:00.000Z"), &[]).await;
    schedule(&api, &project, "Soon", Some("2026-11-08T00:00:00.000Z"), &[]).await;
    schedule(&api, &project, "Also never", None, &[]).await;
    let reply = api.get(&format!("/api/projects/{project}/schedules")).send().await;
    assert_eq!(titles(&reply.body), ["Soon", "A later", "b later", "Also never", "Never"]);
}

#[tokio::test]
async fn every_projects_schedules_are_in_the_agenda_and_only_its_own_in_a_projects() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let squares = api.project("Squares").await;
    schedule(&api, &primes, "Primes job", Some("2026-11-09T00:00:00.000Z"), &[]).await;
    schedule(&api, &squares, "Squares job", Some("2026-11-08T00:00:00.000Z"), &[]).await;
    let all = api.get("/api/schedules").send().await;
    assert_eq!(all.status, 200);
    assert_eq!(titles(&all.body), ["Squares job", "Primes job"]);
    assert_eq!(titles(&api.get(&format!("/api/projects/{primes}/schedules")).send().await.body), ["Primes job"]);
}

#[tokio::test]
async fn a_schedule_across_projects_says_which_its_made_on() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let squares = api.project("Squares").await;
    let across: i64 = sqlx::query_scalar(
        "INSERT INTO schedules_across (projects, skip, body, created_by, created_at, updated_at) VALUES ('*', '[\"x\"]', '{\"title\":\"Tidy\",\"cron\":\"0 9 * * *\",\"enabled\":false}', 'owner', '2026-11-01', '2026-11-02') RETURNING id",
    )
    .fetch_one(&api.app.pool)
    .await
    .unwrap();
    let listed: i64 = sqlx::query_scalar(&format!(
        "INSERT INTO schedules_across (projects, body, created_by, created_at, updated_at) VALUES ('[\"{primes}\"]', '{{\"title\":\"Listed\"}}', 'owner', '2026-11-03', '2026-11-03') RETURNING id"
    ))
    .fetch_one(&api.app.pool)
    .await
    .unwrap();
    let across_sql = across.to_string();
    schedule(&api, &squares, "Tidy", None, &[("across", &across_sql)]).await;
    schedule(&api, &primes, "Tidy", None, &[("across", &across_sql)]).await;
    let reply = api.get("/api/schedules/across").send().await;
    assert_eq!(reply.status, 200);
    let all = reply.body.as_array().unwrap();
    assert_eq!(all.len(), 2, "oldest first");
    let first = &all[0];
    assert_eq!(first["id"], across);
    assert_eq!(first["title"], "Tidy");
    assert_eq!(first["cron"], "0 9 * * *");
    assert_eq!(first["enabled"], false);
    assert_eq!(first["projects"], "*");
    assert_eq!(first["skip"], json!(["x"]));
    let mut on = vec![primes.clone(), squares.clone()];
    on.sort();
    assert_eq!(first["on_projects"], json!(on));
    assert_eq!(first["created_by"], "owner");
    assert_eq!(all[1]["id"], listed);
    assert_eq!(all[1]["projects"], json!([primes]));
    assert_eq!(all[1]["enabled"], true, "on unless it says otherwise");
    assert_eq!(all[1]["on_projects"], json!([]));
    let copy = api.get(&format!("/api/projects/{primes}/schedules")).send().await.body;
    assert_eq!(copy[0]["across"], across, "a copy points back to it");
}

/// The outbox's rows, as `(kind, project)`.
async fn outbox(api: &TestApi) -> Vec<(String, Option<String>)> {
    let rows = sqlx::query("SELECT kind, project FROM changes ORDER BY id").fetch_all(&api.app.pool).await.unwrap();
    rows.iter().map(|r| (sqlx::Row::get(r, "kind"), sqlx::Row::get(r, "project"))).collect()
}

async fn count(api: &TestApi, query: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(query).fetch_one(&api.app.pool).await.unwrap()
}

#[tokio::test]
async fn the_owner_makes_an_agents_schedule_theirs() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id = schedule(&api, &project, "Nightly tidy", None, &[("created_by", "'claude'")]).await;
    let path = format!("/api/projects/{project}/schedules/{id}/adopt");
    // Only the owner takes one on.
    let refused = api.post(&path, json!({})).by_agent("claude").send().await;
    assert_eq!(refused.status, 403);
    assert_eq!(refused.body["data"]["permission"], "schedules.adopt");
    // Read before a change, it's refused, so they never take on words they haven't seen.
    let stale = api.post(&path, json!({"seen": "2026-10-01T00:00:00.000Z"})).send().await;
    assert_eq!(stale.status, 409, "{}", stale.body);
    assert_eq!(api.post(&path, json!({"seen": 3})).send().await.status, 400);
    let adopted = api.post(&path, json!({"seen": "2026-11-02T00:00:00.000Z"})).send().await;
    assert_eq!(adopted.status, 200, "{}", adopted.body);
    assert_eq!(adopted.body["protected"], true);
    assert_eq!(adopted.body["created_by"], "owner");
    assert_ne!(adopted.body["updated_at"], "2026-11-02T00:00:00.000Z");
    assert_eq!(adopted.header("orrery-schedules"), Some(project.as_str()));
    assert_eq!(outbox(&api).await.last(), Some(&("schedules".into(), Some(project.clone()))));
    // Theirs already, with no body at all, it comes back as it is, and nothing changed.
    let again = api.post(&path, json!(null)).send().await;
    assert_eq!(again.status, 200, "{}", again.body);
    assert_eq!(again.body["updated_at"], adopted.body["updated_at"]);
    assert_eq!(again.header("orrery-schedules"), None);
    assert_eq!(api.post(&format!("/api/projects/{project}/schedules/999/adopt"), json!({})).send().await.status, 404);
}

#[tokio::test]
async fn deleting_a_schedule_keeps_its_issues() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id = schedule(&api, &project, "Weekly review", None, &[]).await;
    let issue = api.issue(&project, json!({"title": "Review week 45"})).await;
    sqlx::query(&crate::db::sql("UPDATE issues SET schedule = ? WHERE project = ?")).bind(id).bind(&project).execute(&api.app.pool).await.unwrap();
    run(&api, id, "2026-11-03T08:00:00.000Z", "made", Some(&issue)).await;
    let reply = api.delete(&format!("/api/projects/{project}/schedules/{id}")).send().await;
    assert_eq!(reply.status, 204, "{}", reply.body);
    assert_eq!(reply.header("orrery-schedules"), Some(project.as_str()));
    assert_eq!(api.get(&format!("/api/projects/{project}/schedules/{id}")).send().await.status, 404);
    assert_eq!(count(&api, "SELECT CAST(count(*) AS BIGINT) FROM issues WHERE schedule IS NULL").await, 1);
    assert_eq!(outbox(&api).await.iter().filter(|(kind, _)| kind == "schedules").count(), 1);
    assert_eq!(api.delete(&format!("/api/projects/{project}/schedules/{id}")).send().await.status, 404);
}

#[tokio::test]
async fn only_the_owner_deletes_their_own() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let mine = schedule(&api, &project, "Mine", None, &[("owned", "1")]).await;
    let theirs = schedule(&api, &project, "An agent's", None, &[("created_by", "'claude'")]).await;
    let refused = api.delete(&format!("/api/projects/{project}/schedules/{mine}")).by_agent("claude").send().await;
    assert_eq!(refused.status, 403);
    assert_eq!(refused.body["data"]["permission"], "schedules.owners");
    assert!(outbox(&api).await.iter().all(|(kind, _)| kind != "schedules"));
    assert_eq!(api.delete(&format!("/api/projects/{project}/schedules/{theirs}")).by_agent("claude").send().await.status, 204);
    assert_eq!(api.delete(&format!("/api/projects/{project}/schedules/{mine}")).send().await.status, 204);
}

#[tokio::test]
async fn deleting_one_made_across_projects_leaves_its_project_out() {
    let api = TestApi::new().await;
    let primes = api.project("Primes").await;
    let shop = api.project("Shop").await;
    let across = |projects: &str, skip: &str| {
        format!("INSERT INTO schedules_across (projects, skip, body, created_by, created_at, updated_at) VALUES ('{projects}', '{skip}', '{{\"title\":\"Standup\"}}', 'owner', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z') RETURNING id")
    };
    // One for every project skips this one from then on.
    let every = sqlx::query_scalar::<_, i64>(&across("*", "[]")).fetch_one(&api.app.pool).await.unwrap();
    let copy = schedule(&api, &primes, "Standup", None, &[("across", &every.to_string())]).await;
    assert_eq!(api.delete(&format!("/api/projects/{primes}/schedules/{copy}")).send().await.status, 204);
    let skip: String =
        sqlx::query_scalar(&crate::db::sql("SELECT skip FROM schedules_across WHERE id = ?")).bind(every).fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&skip).unwrap(), json!([primes]));
    // One naming projects names it no more; the last one out takes it with it.
    let named = sqlx::query_scalar::<_, i64>(&across(&json!([primes, shop]).to_string(), "[]")).fetch_one(&api.app.pool).await.unwrap();
    let on_primes = schedule(&api, &primes, "Standup", None, &[("across", &named.to_string())]).await;
    let on_shop = schedule(&api, &shop, "Standup", None, &[("across", &named.to_string())]).await;
    assert_eq!(api.delete(&format!("/api/projects/{primes}/schedules/{on_primes}")).send().await.status, 204);
    let projects: String =
        sqlx::query_scalar(&crate::db::sql("SELECT projects FROM schedules_across WHERE id = ?")).bind(named).fetch_one(&api.app.pool).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&projects).unwrap(), json!([shop]));
    assert_eq!(api.delete(&format!("/api/projects/{shop}/schedules/{on_shop}")).send().await.status, 204);
    assert_eq!(count(&api, &format!("SELECT CAST(count(*) AS BIGINT) FROM schedules_across WHERE id = {named}")).await, 0);
}

#[tokio::test]
async fn the_owner_pauses_all_of_a_projects_schedules_at_once() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let weekly = schedule(&api, &project, "Weekly", Some("2026-11-09T08:00:00.000Z"), &[("enabled", "1")]).await;
    let _paused = schedule(&api, &project, "Paused", None, &[("enabled", "0")]).await;
    let theirs = schedule(&api, &project, "An agent's", Some("2026-11-10T08:00:00.000Z"), &[("enabled", "1"), ("created_by", "'claude'")]).await;
    let path = format!("/api/projects/{project}/schedules/enabled");
    let reply = api.post(&path, json!({"enabled": false})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let ids: Vec<i64> = reply.body["changed"].as_array().unwrap().iter().map(|s| s["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, [weekly, theirs], "the paused one isn't changed again");
    assert_eq!(reply.body["failed"], json!([]));
    for changed in reply.body["changed"].as_array().unwrap() {
        assert_eq!(changed["enabled"], false);
        assert_eq!(changed.get("next_run"), None, "a paused one has no next run");
        assert_ne!(changed["updated_at"], "2026-11-02T00:00:00.000Z");
    }
    assert_eq!(api.get(&format!("/api/projects/{project}/schedules/{theirs}")).send().await.body["created_by"], "claude", "an agent's stays the agent's");
    assert_eq!(reply.header("orrery-schedules"), Some(project.as_str()));
    assert_eq!(outbox(&api).await.iter().filter(|(kind, _)| kind == "schedules").count(), 1, "said once, for all of them");
}

#[tokio::test]
async fn activating_all_works_out_each_next_run_and_leaves_a_one_off() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let weekly = schedule(&api, &project, "Weekly", None, &[("enabled", "0")]).await;
    let _once = schedule(&api, &project, "Once", None, &[("enabled", "0"), ("at", "'2099-01-01T09:00:00.000Z'")]).await;
    let on_event =
        schedule(&api, &project, "On review", None, &[("enabled", "0"), ("on_event", "'issue.status'"), ("on_filter", "'{\"to\":\"in-review\"}'")]).await;
    let reply = api.post(&format!("/api/projects/{project}/schedules/enabled"), json!({"enabled": true})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let changed = reply.body["changed"].as_array().unwrap();
    let ids: Vec<i64> = changed.iter().map(|s| s["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, [weekly, on_event], "a paused one-off may have run, so it stays paused");
    // `0 9 * * 1` in Oslo: a Monday, at 08:00 or 07:00 UTC, still ahead.
    let next = changed[0]["next_run"].as_str().unwrap();
    let at = chrono::DateTime::parse_from_rfc3339(next).unwrap();
    assert!(at > chrono::Utc::now(), "{next}");
    assert_eq!(chrono::Datelike::weekday(&at.with_timezone(&chrono_tz::Europe::Oslo)), chrono::Weekday::Mon);
    assert!(next.ends_with(":00:00.000Z"), "{next}");
    assert_eq!(changed[1]["enabled"], true);
    assert_eq!(changed[1].get("next_run"), None, "an event's runs on the event");
    assert_eq!(changed[1]["on_filter"], json!({"to": "in-review"}));
    // Nothing left to turn on: no change said.
    let again = api.post(&format!("/api/projects/{project}/schedules/enabled"), json!({"enabled": true})).send().await;
    assert_eq!(again.body, json!({"changed": [], "failed": []}));
    assert_eq!(again.header("orrery-schedules"), None);
}

#[tokio::test]
async fn one_that_cant_be_activated_doesnt_stop_the_rest() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let broken = schedule(&api, &project, "Lost zone", None, &[("enabled", "0"), ("timezone", "'Mars/Olympus'")]).await;
    let fine = schedule(&api, &project, "Fine", None, &[("enabled", "0")]).await;
    let reply = api.post(&format!("/api/projects/{project}/schedules/enabled"), json!({"enabled": true})).send().await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body["changed"][0]["id"], fine);
    assert_eq!(
        reply.body["failed"],
        json!([{"id": broken, "title": "Lost zone", "message": "\"timezone\" is \"Mars/Olympus\", not a timezone orrery knows (e.g. Europe/Oslo)"}])
    );
    assert_eq!(api.get(&format!("/api/projects/{project}/schedules/{broken}")).send().await.body["enabled"], false);
}

#[tokio::test]
async fn only_the_owner_pauses_or_activates_them_all() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id = schedule(&api, &project, "Weekly", Some("2026-11-09T08:00:00.000Z"), &[("enabled", "1")]).await;
    let path = format!("/api/projects/{project}/schedules/enabled");
    let refused = api.post(&path, json!({"enabled": false})).by_agent("claude").send().await;
    assert_eq!(refused.status, 403);
    assert_eq!(refused.body["data"]["permission"], "schedules.enabled");
    assert!(refused.body["message"].as_str().unwrap().ends_with("Send Orrery-Actor: <owner>"), "{}", refused.body);
    assert_eq!(api.get(&format!("/api/projects/{project}/schedules/{id}")).send().await.body["enabled"], true);
    for body in [json!({}), json!({"enabled": "no"}), json!(null)] {
        let bad = api.post(&path, body.clone()).send().await;
        assert_eq!(bad.status, 400, "{body}");
        assert_eq!(bad.body["message"], "Send {\"enabled\": true} or {\"enabled\": false}");
    }
}

#[tokio::test]
async fn changing_one_sets_what_was_sent_and_works_out_its_next_run_again() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id = schedule(&api, &project, "Weekly", Some("2026-11-09T08:00:00.000Z"), &[]).await;
    let path = format!("/api/projects/{project}/schedules/{id}");
    let changed = api.patch(&path, json!({"title": "  Daily ", "cron": "0 7 * * *", "timezone": "UTC", "labels": ["a", "a"], "priority": "P1"})).send().await;
    assert_eq!(changed.status, 200, "{}", changed.body);
    let s = &changed.body;
    assert_eq!(
        (s["title"].as_str(), s["cron"].as_str(), s["timezone"].as_str(), s["priority"].as_str()),
        (Some("Daily"), Some("0 7 * * *"), Some("UTC"), Some("P1"))
    );
    assert_eq!(s["labels"], json!(["a"]));
    assert!(s["next_run"].as_str().is_some_and(|n| n.ends_with("T07:00:00.000Z")), "{s}");
    assert_eq!(changed.header("orrery-schedules"), Some(project.as_str()));
    // Setting `at` lets go of the cron; pausing leaves no next run.
    let once = api.patch(&path, json!({"at": "2099-01-01T09:00:00Z", "enabled": false})).send().await;
    assert_eq!(once.status, 200, "{}", once.body);
    assert_eq!((once.body.get("cron"), once.body["at"].as_str(), once.body.get("next_run")), (None, Some("2099-01-01T09:00:00.000Z"), None));
    assert_eq!(once.body["enabled"], false);
    let event = api.patch(&path, json!({"on": "issue.status", "on_filter": {"to": "done"}, "enabled": true})).send().await;
    assert_eq!(event.status, 200, "{}", event.body);
    assert_eq!((event.body["on"].as_str(), event.body.get("at"), event.body["on_filter"].clone()), (Some("issue.status"), None, json!({"to": "done"})));
}

#[tokio::test]
async fn a_change_is_checked_as_schedules_checks_it() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let id = schedule(&api, &project, "Weekly", None, &[]).await;
    let path = format!("/api/projects/{project}/schedules/{id}");
    let bad = |body: Value| api.patch(&path, body).send();
    let reply = bad(json!({"cron": "nope"})).await;
    assert_eq!(
        (reply.status.as_u16(), reply.body["message"].as_str()),
        (400, Some("\"cron\" is \"nope\"; use five fields: minute hour day month weekday, e.g. \"0 9 * * 1-5\""))
    );
    let reply = bad(json!({"kind": "message"})).await;
    assert_eq!(reply.body["message"], "A message schedule needs its message in \"notes\", or a preset in \"presets\"");
    let reply = bad(json!({"kind": "action", "on": "issue.status"})).await;
    assert_eq!(reply.body["message"], "An action schedule moves issues to a status: send it in \"column\"");
    let reply = bad(json!({"column": "done"})).await;
    assert_eq!(reply.body["message"], "A schedule's issues start open, not in Done");
    let reply = bad(json!({"move_from": ["nope"]})).await;
    assert_eq!((reply.status.as_u16(), reply.body["message"].as_str()), (404, Some("No status \"nope\"")));
    let reply = bad(json!({"kind": "message", "presets": [999]})).await;
    assert!(reply.body["message"].as_str().is_some_and(|m| m.starts_with(&format!("No preset 999 for {project}; its sessions can have "))), "{}", reply.body);
    let reply = bad(json!({"untrusted": true})).await;
    assert_eq!(reply.body["message"], "Only a message schedule is untrusted: send \"kind\": \"message\", or \"untrusted\": false");
    let reply = bad(json!({"title": 3, "nope": 1})).await;
    assert_eq!((reply.status.as_u16(), reply.body["message"].as_str()), (400, Some("2 problems in the body")));
    assert_eq!(api.patch(&format!("/api/projects/{project}/schedules/999"), json!({})).send().await.status, 404);
}

#[tokio::test]
async fn the_owners_is_theirs_and_one_across_projects_is_only_paused_here() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    let owned = schedule(&api, &project, "Mine", None, &[("owned", "1")]).await;
    let refused = api.patch(&format!("/api/projects/{project}/schedules/{owned}"), json!({"title": "Yours"})).by_agent("claude").send().await;
    assert_eq!((refused.status.as_u16(), refused.body["data"]["permission"].as_str()), (403, Some("schedules.owners")));
    let session = api.patch(&format!("/api/projects/{project}/schedules/{owned}"), json!({"kind": "session"})).send().await;
    assert_eq!(session.status, 200, "the owner makes a session schedule: {}", session.body);
    let agents = schedule(&api, &project, "Agent's", None, &[("created_by", "'claude'")]).await;
    let refused = api.patch(&format!("/api/projects/{project}/schedules/{agents}"), json!({"kind": "session"})).by_agent("claude").send().await;
    assert_eq!((refused.status.as_u16(), refused.body["data"]["permission"].as_str()), (403, Some("schedules.session")));
    let across = sqlx::query_scalar::<_, i64>(
        "INSERT INTO schedules_across (projects, skip, body, created_by, created_at, updated_at) VALUES ('*', '[]', '{}', 'owner', '2026-11-01', '2026-11-02') RETURNING id",
    )
    .fetch_one(&api.app.pool)
    .await
    .unwrap();
    let copy = schedule(&api, &project, "Copy", None, &[("across", &across.to_string())]).await;
    let path = format!("/api/projects/{project}/schedules/{copy}");
    let refused = api.patch(&path, json!({"title": "Other"})).send().await;
    assert_eq!(refused.status, 409);
    assert_eq!(refused.body["message"], format!("Schedule {copy} is made from schedule across projects {across}: change it there, or pause it here"));
    assert_eq!(api.patch(&path, json!({"enabled": false})).send().await.body["enabled"], false);
}
