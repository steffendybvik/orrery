// A working session asking the owner for a schedule on its issue (ORR-1100), through `router()` on a database of its
// own, as web/test/schedule-requests.test.ts asks it of the Nuxt server's.
use super::{ask_line, js_string};
use crate::testing::TestApi;
use serde_json::{json, Value};

fn path(project: &str, issue: &str) -> String {
    format!("/api/projects/{project}/issues/{issue}/schedule-requests")
}

async fn schedules(api: &TestApi, project: &str) -> Value {
    api.get(&format!("/api/projects/{project}/schedules")).send().await.body
}

#[tokio::test]
async fn asks_on_its_issue_and_saves_nothing() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let body = json!({"schedule": {"title": "Morning check", "kind": "message", "notes": "Look at the board.", "cron": "0 9 * * 1-5"}, "why": "You asked for a daily nudge."});
    let reply = api.post(&path(&project, &issue), body).by_agent("claude").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    let asked = &reply.body;
    assert_eq!(asked["asks"], "decision");
    assert_eq!(asked["answered"], false);
    assert_eq!(asked["created_by"], "claude");
    assert_eq!(asked["schedule"]["title"], "Morning check");
    assert_eq!(asked["schedule"]["state"], "asked");
    assert!(asked["schedule"].get("id").is_none());
    assert_eq!(asked["schedule"]["changes"][0], json!({"field": "title", "to": "Morning check"}));
    assert!(asked["body"].as_str().unwrap().starts_with("You asked for a daily nudge.\n\nAsks to make the schedule \"Morning check\". Nothing is saved"));
    assert_eq!(schedules(&api, &project).await, json!([]));
    // The comment reaches the owner's bell, as a new comment's does, and the event log hears it through the router.
    assert!(reply.header("orrery-notice").is_some());
    let line = reply.header("orrery-asked").unwrap();
    let parts = line.split(' ').map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().to_string()).collect::<Vec<_>>();
    assert_eq!(parts, [project.as_str(), issue.as_str(), "-", "title,kind,notes,cron", "make the schedule \"Morning check\""]);
    // It's the issue's, as any comment is, and the schedule's request is in its list too.
    let listed = api.get(&format!("/api/projects/{project}/issues/{issue}/comments")).send().await.body;
    assert_eq!(listed[0]["schedule"]["title"], "Morning check");
}

#[tokio::test]
async fn changes_one_field_by_field_and_the_owner_asks_no_one() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let made = api
        .post(&format!("/api/projects/{project}/schedules"), json!({"title": "Nightly", "kind": "message", "notes": "Hi", "cron": "0 2 * * *"}))
        .send()
        .await;
    assert_eq!(made.status, 201, "{}", made.body);
    let id = made.body["id"].as_i64().unwrap();
    let reply = api.post(&path(&project, &issue), json!({"id": id, "schedule": {"enabled": false}})).by_agent("claude").send().await;
    assert_eq!(reply.status, 201, "{}", reply.body);
    assert_eq!(reply.body["schedule"]["id"], id);
    assert_eq!(reply.body["schedule"]["changes"], json!([{"field": "enabled", "from": true, "to": false}]));
    assert!(reply.body["body"].as_str().unwrap().contains(&format!("change schedule {id} (\"Nightly\"): Running to off")));
    assert_eq!(schedules(&api, &project).await[0]["enabled"], true);
    // The owner makes and changes schedules on Schedules.
    let own = api.post(&path(&project, &issue), json!({"schedule": {"title": "X", "cron": "0 9 * * *"}})).send().await;
    assert_eq!(own.status, 400);
}

#[tokio::test]
async fn expires_the_earlier_request_for_the_same_schedule() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let ask = |notes: &str| json!({"schedule": {"title": "Weekly", "kind": "message", "notes": notes, "cron": "0 9 * * 1"}});
    let first = api.post(&path(&project, &issue), ask("A")).by_agent("claude").send().await.body;
    let second = api.post(&path(&project, &issue), ask("B")).by_agent("claude").send().await.body;
    let comment = |id: &Value| format!("/api/projects/{project}/issues/{issue}/comments/{id}");
    assert_eq!(api.get(&comment(&first["id"])).send().await.body["schedule"]["state"], "expired");
    assert_eq!(api.get(&comment(&second["id"])).send().await.body["schedule"]["state"], "asked");
}

#[tokio::test]
async fn is_checked_as_schedules_would_check_it() {
    let api = TestApi::new().await;
    let (project, issue) = api.board().await;
    let to = path(&project, &issue);
    for (body, status) in [
        (json!({"schedule": {"title": "Bad", "cron": "often"}}), 400),
        (json!({"schedule": {"title": "X", "cron": "0 9 * * *", "untrusted": true}}), 403),
        (json!({"schedule": {}}), 400),
        (json!({"id": "3", "schedule": {"enabled": false}}), 400),
        (json!({"id": 999, "schedule": {"enabled": false}}), 404),
    ] {
        let reply = api.post(&to, body.clone()).by_agent("claude").send().await;
        assert_eq!(reply.status, status, "{body}: {}", reply.body);
    }
    let listed = api.get(&format!("/api/projects/{project}/issues/{issue}/comments")).send().await.body;
    assert_eq!(listed, json!([]));
    assert_eq!(schedules(&api, &project).await, json!([]));
}

#[test]
fn says_what_it_asks_as_the_channel_does() {
    assert_eq!(ask_line(&json!({"title": "Daily"})), "make the schedule \"Daily\"");
    let change = json!({"id": 3, "title": "Daily", "changes": [
        {"field": "presets", "to": ["Reviewer", 9]}, {"field": "on_filter", "to": {"to": "done"}}, {"field": "notes", "to": ""}, {"field": "ask", "to": true}
    ]});
    assert_eq!(ask_line(&change), "change schedule 3 (\"Daily\"): Presets to Reviewer, 9, Event filter to to: done, Notes to (none), Ask sessions to on");
    assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
}
