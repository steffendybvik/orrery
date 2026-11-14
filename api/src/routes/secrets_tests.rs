// The tests of routes/secrets.rs (ORR-1052), through `router()` on a database of their own (`crate::testing`).
use crate::testing::TestApi;
use serde_json::json;
use sqlx::Row;

/// The sealed value a secret holds: it must never come back.
const SEALED: &str = "v1:sealed-ciphertext-that-must-never-leave";

async fn secret(api: &TestApi, name: &str, hosts: &str, projects: Option<&str>) {
    sqlx::query(&crate::db::sql(
        "INSERT INTO secrets (name, value, last4, hosts, projects, created_by, owned, created_at, updated_at) VALUES (?, ?, 'wxyz', ?, ?, 'owner', 1, ?, ?)",
    ))
    .bind(name)
    .bind(SEALED)
    .bind(hosts)
    .bind(projects.map(str::to_owned))
    .bind("2026-11-01T00:00:00.000Z")
    .bind("2026-11-02T00:00:00.000Z")
    .execute(&api.app.pool)
    .await
    .unwrap();
}

async fn used(api: &TestApi, name: &str, path: &str, status: Option<i64>) {
    sqlx::query(&crate::db::sql("INSERT INTO secret_uses (secret, method, host, path, project, issue, status, error, created_by, created_at) VALUES (?, 'POST', 'api.example', ?, 'primes', 'PRI-1', ?, NULL, 'claude', ?)"))
        .bind(name)
        .bind(path)
        .bind(status)
        .bind(crate::write::stamp())
        .execute(&api.app.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn lists_every_secret_by_name_with_its_latest_use_and_never_its_value() {
    let api = TestApi::new().await;
    secret(&api, "STRIPE_KEY", r#"["api.stripe.com"]"#, Some(r#"["shop"]"#)).await;
    secret(&api, "GITHUB_TOKEN", r#"["api.github.com","uploads.github.com"]"#, None).await;
    used(&api, "STRIPE_KEY", "/v1/first", Some(200)).await;
    used(&api, "STRIPE_KEY", "/v1/second", None).await;
    let listed = api.get("/api/secrets").send().await;
    assert_eq!(listed.status, 200, "{}", listed.body);
    assert!(!listed.body.to_string().contains(SEALED) && !listed.body.to_string().contains("\"value\""), "{}", listed.body);
    let secrets = listed.body.as_array().unwrap();
    assert_eq!(secrets.iter().map(|s| s["name"].as_str().unwrap()).collect::<Vec<_>>(), ["GITHUB_TOKEN", "STRIPE_KEY"]);
    let github = &secrets[0];
    assert_eq!(github["hosts"], json!(["api.github.com", "uploads.github.com"]));
    assert_eq!(github["projects"], json!(null), "null is any project");
    assert_eq!(github["last_used"], json!(null));
    assert_eq!(github["last4"], "wxyz");
    let stripe = &secrets[1];
    assert_eq!(stripe["projects"], json!(["shop"]));
    assert_eq!(stripe["last_used"]["path"], "/v1/second");
    assert_eq!(stripe["last_used"]["status"], json!(null));
    assert_eq!(
        (stripe["created_by"].as_str(), stripe["created_at"].as_str(), stripe["updated_at"].as_str()),
        (Some("owner"), Some("2026-11-01T00:00:00.000Z"), Some("2026-11-02T00:00:00.000Z"))
    );
}

#[tokio::test]
async fn lists_none_when_there_are_none() {
    let api = TestApi::new().await;
    let listed = api.get("/api/secrets").send().await;
    assert_eq!((listed.status.as_u16(), listed.body.clone()), (200, json!([])));
}

#[tokio::test]
async fn gets_one_secret_with_its_twenty_latest_uses_newest_first_and_never_its_value() {
    let api = TestApi::new().await;
    secret(&api, "STRIPE_KEY", r#"["api.stripe.com"]"#, None).await;
    secret(&api, "OTHER", "[]", None).await;
    for n in 0..25 {
        used(&api, "STRIPE_KEY", &format!("/v1/{n}"), Some(200 + n)).await;
    }
    used(&api, "OTHER", "/elsewhere", Some(500)).await;
    let got = api.get("/api/secrets/STRIPE_KEY").send().await;
    assert_eq!(got.status, 200, "{}", got.body);
    assert!(!got.body.to_string().contains(SEALED) && got.body.get("value").is_none(), "{}", got.body);
    let uses = got.body["uses"].as_array().unwrap();
    assert_eq!(uses.len(), 20);
    assert_eq!(uses.iter().map(|u| u["path"].as_str().unwrap().to_string()).collect::<Vec<_>>(), (5..25).rev().map(|n| format!("/v1/{n}")).collect::<Vec<_>>());
    assert_eq!(got.body["last_used"], uses[0]);
    let first = &uses[0];
    assert_eq!(
        (
            first["secret"].as_str(),
            first["method"].as_str(),
            first["host"].as_str(),
            first["project"].as_str(),
            first["issue"].as_str(),
            first["status"].as_i64(),
            first["created_by"].as_str()
        ),
        (Some("STRIPE_KEY"), Some("POST"), Some("api.example"), Some("primes"), Some("PRI-1"), Some(224), Some("claude"))
    );
    assert!(first["id"].is_i64() && first["error"].is_null());
}

#[tokio::test]
async fn a_secret_not_kept_isnt_found() {
    let api = TestApi::new().await;
    secret(&api, "STRIPE_KEY", "[]", None).await;
    let missing = api.get("/api/secrets/stripe_key").send().await;
    assert_eq!(missing.status, 404, "{}", missing.body);
    let unused = api.get("/api/secrets/STRIPE_KEY").send().await;
    assert_eq!((unused.body["uses"].clone(), unused.body["last_used"].clone()), (json!([]), json!(null)));
}

#[tokio::test]
async fn reading_secrets_writes_nothing() {
    let api = TestApi::new().await;
    secret(&api, "STRIPE_KEY", "[]", None).await;
    api.get("/api/secrets").send().await;
    api.get("/api/secrets/STRIPE_KEY").send().await;
    let uses: i64 = sqlx::query("SELECT count(*) FROM secret_uses").fetch_one(&api.app.pool).await.unwrap().get(0);
    let changes: i64 = sqlx::query("SELECT count(*) FROM changes").fetch_one(&api.app.pool).await.unwrap().get(0);
    assert_eq!((uses, changes), (0, 0));
}

fn sealed(value: &str, hosts: serde_json::Value, projects: serde_json::Value, at: &str) -> serde_json::Value {
    json!({"value": value, "last4": "wxyz", "hosts": hosts, "projects": projects, "created_by": "owner", "owned": true, "at": at})
}

#[tokio::test]
async fn keeps_a_sealed_secret_and_reads_it_back_without_its_value() {
    let api = TestApi::new().await;
    let reply = api.put("/api/secrets/STRIPE_KEY/sealed", sealed(SEALED, json!(["api.stripe.com"]), json!(["shop"]), "2026-11-10T10:00:00.000Z")).send().await;
    assert_eq!(reply.status, 204, "{}", reply.body);
    let read = api.get("/api/secrets/STRIPE_KEY").send().await.body;
    assert_eq!(read["hosts"], json!(["api.stripe.com"]));
    assert_eq!(read["projects"], json!(["shop"]));
    assert!(!read.to_string().contains(SEALED), "{read}");
    let kept: String = sqlx::query("SELECT value FROM secrets WHERE name = 'STRIPE_KEY'").fetch_one(&api.app.pool).await.unwrap().get("value");
    assert_eq!(kept, SEALED, "kept as the local app sealed it");
}

#[tokio::test]
async fn keeping_one_again_replaces_its_value_and_keeps_who_made_it_and_when() {
    let api = TestApi::new().await;
    api.put("/api/secrets/STRIPE_KEY/sealed", sealed(SEALED, json!(["api.stripe.com"]), json!(null), "2026-11-01T00:00:00.000Z")).send().await;
    let mut again = sealed("v1:another", json!(["api.stripe.com"]), json!(["shop"]), "2026-11-10T10:00:00.000Z");
    again["created_by"] = json!("claude");
    assert_eq!(api.put("/api/secrets/STRIPE_KEY/sealed", again).send().await.status, 204);
    let row = sqlx::query("SELECT value, projects, created_by, created_at, updated_at FROM secrets WHERE name = 'STRIPE_KEY'")
        .fetch_one(&api.app.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("value"), "v1:another");
    assert_eq!(row.get::<Option<String>, _>("projects").as_deref(), Some(r#"["shop"]"#));
    assert_eq!(row.get::<String, _>("created_by"), "owner");
    assert_eq!(row.get::<String, _>("created_at"), "2026-11-01T00:00:00.000Z");
    assert_eq!(row.get::<String, _>("updated_at"), "2026-11-10T10:00:00.000Z");
}

#[tokio::test]
async fn says_each_problem_with_a_sealed_secret_or_a_use() {
    let api = TestApi::new().await;
    let reply = api.put("/api/secrets/STRIPE_KEY/sealed", json!({"value": 1, "hosts": "all", "colour": "red"})).send().await;
    assert_eq!(reply.status, 400, "{}", reply.body);
    let said = reply.body.to_string();
    for part in ["colour", "\\\"value\\\"", "hosts", "last4", "owned"] {
        assert!(said.contains(part), "{part} in {said}");
    }
    assert_eq!(api.post("/api/secrets/STRIPE_KEY/uses", json!({"method": "GET", "status": "ok"})).send().await.status, 400);
}

#[tokio::test]
async fn forgetting_a_secret_takes_its_uses_too() {
    let api = TestApi::new().await;
    secret(&api, "STRIPE_KEY", r#"["api.stripe.com"]"#, None).await;
    secret(&api, "GITHUB_TOKEN", r#"["api.github.com"]"#, None).await;
    used(&api, "STRIPE_KEY", "/v1/a", Some(200)).await;
    used(&api, "GITHUB_TOKEN", "/graphql", Some(200)).await;
    assert_eq!(api.delete("/api/secrets/STRIPE_KEY/sealed").send().await.status, 204);
    let left: Vec<String> = sqlx::query("SELECT name FROM secrets").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("name")).collect();
    assert_eq!(left, vec!["GITHUB_TOKEN".to_string()]);
    let uses: Vec<String> = sqlx::query("SELECT secret FROM secret_uses").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("secret")).collect();
    assert_eq!(uses, vec!["GITHUB_TOKEN".to_string()]);
}

#[tokio::test]
async fn keeps_a_use_and_with_keep_only_the_latest_by_who_made_them() {
    let api = TestApi::new().await;
    secret(&api, "GITHUB_TOKEN", r#"["api.github.com"]"#, None).await;
    used(&api, "GITHUB_TOKEN", "/a-session", Some(200)).await;
    let made = |path: &str| json!({"method": "POST", "host": "api.github.com", "path": path, "project": "primes", "issue": null, "status": 200, "error": null, "created_by": "orrery", "created_at": "2026-11-10T10:00:00.000Z", "keep": 2});
    for path in ["/one", "/two", "/three"] {
        let reply = api.post("/api/secrets/GITHUB_TOKEN/uses", made(path)).send().await;
        assert_eq!(reply.status, 204, "{}", reply.body);
    }
    let failed = json!({"method": "GET", "host": "api.github.com", "path": "/x", "project": null, "issue": "PRI-1", "status": null, "error": "timed out", "created_by": "claude", "created_at": "2026-11-10T10:01:00.000Z"});
    assert_eq!(api.post("/api/secrets/GITHUB_TOKEN/uses", failed).send().await.status, 204);
    let paths: Vec<String> =
        sqlx::query("SELECT path FROM secret_uses ORDER BY id").fetch_all(&api.app.pool).await.unwrap().iter().map(|r| r.get("path")).collect();
    assert_eq!(paths, vec!["/a-session", "/two", "/three", "/x"], "orrery's own kept to the latest two; the others untouched");
    let read = api.get("/api/secrets/GITHUB_TOKEN").send().await.body;
    assert_eq!(read["last_used"]["error"], "timed out");
}

#[tokio::test]
async fn the_local_app_reads_a_secret_as_sealed_to_open_it_with_its_key() {
    let api = TestApi::new().await;
    secret(&api, "STRIPE_KEY", r#"["api.stripe.com"]"#, Some(r#"["shop"]"#)).await;
    secret(&api, "GITHUB_TOKEN", r#"["api.github.com"]"#, None).await;
    let one = api.get("/api/secrets/STRIPE_KEY/sealed").send().await;
    assert_eq!(one.status, 200, "{}", one.body);
    assert_eq!(
        one.body,
        json!({"name": "STRIPE_KEY", "value": SEALED, "last4": "wxyz", "hosts": r#"["api.stripe.com"]"#, "projects": r#"["shop"]"#,
            "created_by": "owner", "owned": 1, "created_at": "2026-11-01T00:00:00.000Z", "updated_at": "2026-11-02T00:00:00.000Z"})
    );
    let all = api.get("/api/sealed-secrets").send().await;
    assert_eq!(all.status, 200, "{}", all.body);
    let names: Vec<&str> = all.body.as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["GITHUB_TOKEN", "STRIPE_KEY"]);
    assert_eq!(all.body[0]["projects"], json!(null));
    let missing = api.get("/api/secrets/NOPE/sealed").send().await;
    assert_eq!((missing.status.as_u16(), missing.body["message"].as_str()), (404, Some("No secret NOPE")));
}

#[tokio::test]
async fn only_the_local_app_reads_a_secret_as_sealed() {
    let api = TestApi::new().await;
    secret(&api, "STRIPE_KEY", r#"["api.stripe.com"]"#, None).await;
    for path in ["/api/secrets/STRIPE_KEY/sealed", "/api/sealed-secrets"] {
        for refused in [api.get(path).header("orrery-came", "loopback").send().await, api.get(path).header("orrery-came", "server, loopback").send().await] {
            assert_eq!(refused.status, 403, "{path}: {}", refused.body);
            assert!(!refused.body.to_string().contains(SEALED), "{path}: {}", refused.body);
        }
    }
}

/// A secret is its workspace's (ORR-1107): two can each have one of the same name. The local app keeps, reads and
/// forgets one by the project it's for, or the workspace it names; a page or session lists and reads its own.
#[tokio::test]
async fn each_workspace_keeps_its_own_secrets() {
    let api = TestApi::new().await;
    api.team().await;
    let primes = api.project("Primes").await;
    let rockets = api.acme(&["steffen"]).await;
    let keep = |path: String, hosts: &'static str| {
        let api = &api;
        async move { api.put(&path, sealed(SEALED, json!([hosts]), json!(null), "2026-11-10T10:00:00.000Z")).send().await.status }
    };
    assert_eq!(keep("/api/secrets/STRIPE_KEY/sealed".into(), "api.stripe.com").await, 204);
    assert_eq!(keep(format!("/api/secrets/STRIPE_KEY/sealed?project={rockets}"), "rockets.example").await, 204);

    let hosts = |reply: &crate::testing::Reply| reply.body["hosts"].clone();
    let ours = api.get(&format!("/api/secrets/STRIPE_KEY/sealed?project={primes}")).send().await;
    assert_eq!(hosts(&ours), json!("[\"api.stripe.com\"]"), "{}", ours.body);
    let theirs = api.get("/api/secrets/STRIPE_KEY/sealed").header("orrery-workspace", "acme").send().await;
    assert_eq!(hosts(&theirs), json!("[\"rockets.example\"]"), "{}", theirs.body);
    assert_eq!(api.get("/api/sealed-secrets").send().await.body.as_array().unwrap().len(), 2, "the scrubber has every one");

    let listed = api.get("/api/secrets").header("orrery-workspace", "acme").send().await;
    assert_eq!(listed.body.as_array().unwrap().iter().map(|s| s["hosts"].clone()).collect::<Vec<_>>(), [json!(["rockets.example"])]);
    let ana = api.signed(api.get("/api/secrets/STRIPE_KEY").header("orrery-workspace", "acme"), "ana").await.send().await;
    assert_eq!(ana.status, 404, "ana isn't in Acme: {}", ana.body);

    assert_eq!(api.delete(&format!("/api/secrets/STRIPE_KEY/sealed?project={rockets}")).send().await.status, 204);
    assert_eq!(api.get("/api/secrets/STRIPE_KEY").send().await.status, 200, "default's is still there");
    let put = api.put("/api/secrets/STRIPE_KEY/sealed", sealed(SEALED, json!(["evil.example"]), json!(null), "2026-11-10T10:00:00.000Z"));
    let refused = api.signed(put.header("orrery-sent-origin", "http://localhost"), "steffen").await.send().await;
    assert_eq!(refused.status, 403, "only the local app keeps a sealed secret: {}", refused.body);
}
