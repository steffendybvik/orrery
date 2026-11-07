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
