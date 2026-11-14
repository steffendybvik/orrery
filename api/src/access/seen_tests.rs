// The lists and feeds across projects keep only the asker's workspaces (ORR-1106): ana is in `default` alone, bo in
// `default` and Acme, and the owner, steffen, in `default` alone, so neither ana nor the owner sees Acme's Rockets.
use super::*;
use crate::testing::{from_outside, ids, TestApi};
use serde_json::json;

/// The team, Primes in `default` and Rockets in Acme with bo in it: (primes, rockets).
async fn two_workspaces(api: &TestApi) -> (String, String) {
    api.team().await;
    let primes = api.project("Primes").await;
    let rockets = api.acme(&["bo"]).await;
    (primes, rockets)
}

/// `path` as `person` asks it, signed in, through the router: its body.
async fn as_person(api: &TestApi, path: &str, person: &str) -> Value {
    let reply = api.signed(api.get(path), person).await.send().await;
    assert_eq!(reply.status, 200, "{path}: {}", reply.body);
    reply.body
}

/// The `project` of each entry in a list.
fn projects_of(list: &Value) -> Vec<String> {
    list.as_array().expect("a list").iter().map(|e| e["project"].as_str().unwrap_or("-").to_string()).collect()
}

#[test]
fn keeping_drops_only_the_projects_hidden() {
    let hidden: HashSet<String> = ["rockets".to_string()].into();
    let mut list = json!([{"project": "primes"}, {"project": "rockets"}, {"kind": "server"}, {"project": null}, {"project": "gone"}]);
    keep_in(&hidden, &mut list, "project");
    assert_eq!(list, json!([{"project": "primes"}, {"kind": "server"}, {"project": null}, {"project": "gone"}]));
}

#[tokio::test]
async fn the_projects_list_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    assert_eq!(ids(&as_person(&api, "/api/projects", "ana").await), std::slice::from_ref(&primes));
    assert_eq!(ids(&as_person(&api, "/api/projects", "steffen").await), std::slice::from_ref(&primes));
    let mut bos = ids(&as_person(&api, "/api/projects", "bo").await);
    bos.sort();
    assert_eq!(bos, [primes.clone(), rockets.clone()]);
    // The Nuxt server's own work sees every one; a request naming nobody here, only `default`'s.
    assert_eq!(ids(&api.get("/api/projects").send().await.body).len(), 2);
    assert_eq!(ids(&from_outside(api.get("/api/projects").agent_of_nobody()).send().await.body), [primes]);
}

#[tokio::test]
async fn the_changes_feed_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    api.issue(&primes, json!({"title": "Sieve"})).await;
    api.issue(&rockets, json!({"title": "Fuel"})).await;
    let anas = as_person(&api, "/api/changes", "ana").await;
    let seen = projects_of(&anas["changes"]);
    assert!(seen.contains(&primes) && !seen.contains(&rockets), "{seen:?}");
    let bos = projects_of(&as_person(&api, "/api/changes", "bo").await["changes"]);
    assert!(bos.contains(&rockets), "{bos:?}");
    // Where to carry on from is the feed's, whatever was held back.
    assert_eq!(anas["last"], api.get("/api/changes").send().await.body["last"]);
}

#[tokio::test]
async fn the_schedules_agenda_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    for (project, title) in [(&primes, "Primes job"), (&rockets, "Rockets job")] {
        api.run(
            "INSERT INTO schedules (project, title, timezone, cron, created_by, created_at, updated_at) VALUES (?, ?, 'Europe/Oslo', '0 9 * * 1', 'owner', ?, ?)",
            &[project, title, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
        )
        .await;
    }
    assert_eq!(projects_of(&as_person(&api, "/api/schedules", "ana").await), std::slice::from_ref(&primes));
    assert_eq!(projects_of(&as_person(&api, "/api/schedules", "bo").await).len(), 2);
}

#[tokio::test]
async fn a_schedule_across_projects_shows_only_the_askers_projects() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let both = format!("[\"{primes}\",\"{rockets}\"]");
    let theirs = format!("[\"{rockets}\"]");
    for (projects, on) in [(&both, vec![&primes, &rockets]), (&theirs, vec![&rockets])] {
        let id: i64 = sqlx::query_scalar(&sql(
            "INSERT INTO schedules_across (projects, body, created_by, created_at, updated_at) VALUES (?, '{\"title\":\"Tidy\"}', 'owner', '2026-11-03', '2026-11-03') RETURNING id",
        ))
        .bind(projects)
        .fetch_one(&api.app.pool)
        .await
        .unwrap();
        for project in on {
            api.run(
                // The id written in, not bound: a bound one is text, which Postgres won't put in an integer column.
                &format!(
                    "INSERT INTO schedules (project, title, timezone, cron, across, created_by, created_at, updated_at) VALUES (?, 'Tidy', 'Europe/Oslo', '0 9 * * 1', {id}, 'owner', ?, ?)"
                ),
                &[project, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
            )
            .await;
        }
    }
    let anas = as_person(&api, "/api/schedules/across", "ana").await;
    assert_eq!(anas.as_array().unwrap().len(), 1, "{anas}");
    assert_eq!(anas[0]["on_projects"], json!([primes]));
    assert_eq!(as_person(&api, "/api/schedules/across", "bo").await.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn the_event_log_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    let at = "2026-11-14T00:00:00.000Z";
    for project in [&primes, &rockets] {
        api.run(
            "INSERT INTO events (level, kind, project, message, count, first_seen, last_seen) VALUES ('info', 'note', ?, 'Moved', 1, ?, ?)",
            &[project, at, at],
        )
        .await;
    }
    api.run("INSERT INTO events (level, kind, message, count, first_seen, last_seen) VALUES ('info', 'note', 'Started', 1, ?, ?)", &[at, at]).await;
    let mut anas = projects_of(&as_person(&api, "/api/events/log", "ana").await);
    anas.sort();
    assert_eq!(anas, ["-".to_string(), primes]);
    assert_eq!(as_person(&api, "/api/events/log", "bo").await.as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn the_releases_hold_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    api.run("UPDATE projects SET release_mode = 'own'", &[]).await;
    assert_eq!(projects_of(&as_person(&api, "/api/releases", "ana").await), std::slice::from_ref(&primes));
    let mut bos = projects_of(&as_person(&api, "/api/releases", "bo").await);
    bos.sort();
    assert_eq!(bos, [primes, rockets]);
}

#[tokio::test]
async fn the_bell_holds_only_the_askers_workspaces() {
    let api = TestApi::new().await;
    let (primes, rockets) = two_workspaces(&api).await;
    for project in [&primes, &rockets] {
        let made = api.post(&format!("/api/projects/{project}/issues"), json!({"title": "Maybe", "proposal": "pending"})).by_agent("claude").send().await;
        assert_eq!(made.status, 201, "{}", made.body);
    }
    let all = projects_of(&api.get("/api/notices").browser("steffen", true).send().await.body);
    assert!(all.contains(&rockets), "the Nuxt server's own work sees every workspace: {all:?}");
    let owners = from_outside(api.get("/api/notices").header("orrery-actor-owner", "1").header("orrery-actor-name", "steffen")).send().await;
    assert_eq!(owners.status, 200, "{}", owners.body);
    assert_eq!(projects_of(&owners.body), std::slice::from_ref(&primes));
    let changes =
        from_outside(api.get("/api/notices/changes?since=2026-01-01T00:00:00.000Z").header("orrery-actor-owner", "1").header("orrery-actor-name", "steffen"))
            .send()
            .await;
    assert_eq!(changes.status, 200, "{}", changes.body);
    assert!(!projects_of(&changes.body).contains(&rockets), "{}", changes.body);
}
