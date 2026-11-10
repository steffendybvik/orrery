// The tests of the `schedules` tool at `/mcp` (schedules.rs), through `router()` on a database of their own.
use crate::testing::{Reply, TestApi};
use serde_json::{json, Value};

async fn call(api: &TestApi, args: Value) -> Reply {
    api.post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "schedules", "arguments": args}}))
        .header("orrery-actor-kind", "chat")
        .send()
        .await
}

fn said(reply: &Reply) -> &str {
    reply.body["result"]["content"][0]["text"].as_str().expect("a text answer")
}

/// Puts a schedule on `project` with SQL, as there's no write route yet: its `columns` and their SQL values.
async fn schedule(api: &TestApi, project: &str, columns: &[(&str, &str)]) -> i64 {
    let mut all = vec![
        ("project", format!("'{project}'")),
        ("created_by", "'owner'".into()),
        ("created_at", "'2026-11-01T00:00:00.000Z'".into()),
        ("updated_at", "'2026-11-01T00:00:00.000Z'".into()),
    ];
    all.extend(columns.iter().map(|(c, v)| (*c, v.to_string())));
    let query = format!(
        "INSERT INTO schedules ({}) VALUES ({}) RETURNING id",
        all.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(", "),
        all.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(", ")
    );
    sqlx::query_scalar::<_, i64>(&query).fetch_one(&api.app.pool).await.unwrap()
}

#[tokio::test]
async fn no_schedules_says_so() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    assert_eq!(said(&call(&api, json!({})).await), "No schedules yet.");
}

#[tokio::test]
async fn each_schedule_is_a_line_as_the_channel_writes_it() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let weekly = schedule(
        &api,
        "alpha",
        &[("title", "'Weekly review'"), ("cron", "'0 9 * * 1'"), ("timezone", "'Europe/Oslo'"), ("next_run", "'2026-11-16T08:00:00.000Z'")],
    )
    .await;
    sqlx::query(&crate::db::sql("INSERT INTO schedule_runs (schedule, at, outcome, issue, note) VALUES (?, ?, ?, ?, ?)"))
        .bind(weekly)
        .bind("2026-11-09T08:00:00.000Z")
        .bind("made")
        .bind("ALP-1")
        .bind("first")
        .execute(&api.app.pool)
        .await
        .unwrap();
    let on = schedule(
        &api,
        "alpha",
        &[("title", "'On done'"), ("on_event", "'issue.status'"), ("on_filter", "'{\"to\":\"done\"}'"), ("timezone", "'UTC'"), ("enabled", "0")],
    )
    .await;
    let said = said(&call(&api, json!({})).await).to_string();
    let lines: Vec<&str> = said.lines().collect();
    assert!(
        lines.contains(
            &format!(
                "{weekly}: Weekly review [issue, on] 0 9 * * 1 (Europe/Oslo); last 2026-11-09T08:00:00.000Z made ALP-1 (first); next 2026-11-16T08:00:00.000Z"
            )
            .as_str()
        ),
        "{said}"
    );
    assert!(lines.contains(&format!("{on}: On done [issue, paused] on issue.status {{\"to\":\"done\"}}; never run").as_str()), "{said}");
    assert_eq!(lines.len(), 2);
}

#[tokio::test]
async fn a_work_session_doesnt_have_it() {
    let api = TestApi::new().await;
    api.project("alpha").await;
    let reply = api.post("/mcp", json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "schedules", "arguments": {}}})).send().await;
    assert_eq!(reply.body["result"]["isError"], true);
    assert_eq!(said(&reply), "No tool \"schedules\"");
}
