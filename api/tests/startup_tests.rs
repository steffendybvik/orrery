// The built `orrery-api` started as the Nuxt server starts it (ORR-1168): what it refuses to start on and how it says
// so, `orrery-api migrate`'s answer and exit codes, and the start line the Nuxt server reads its port from.
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_orrery-api");
const TOKEN: &str = "a-test-token-of-32-characters!!!";

/// A folder of its own in the temp dir, and the database path in it, which nothing has made yet.
fn database() -> String {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).unwrap();
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("orrery-api-startup-{id}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("orrery.db").to_string_lossy().into_owned()
}

/// The API with only the settings given, none from the environment the tests run in.
fn api(args: &[&str], env: &[(&str, &str)]) -> Command {
    let mut command = Command::new(BIN);
    command.args(args).env_clear();
    // Where llvm-cov wants each run's profile, so startup counts toward coverage.
    if let Ok(profile) = std::env::var("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", profile);
    }
    command.envs(env.iter().copied());
    command
}

fn run(args: &[&str], env: &[(&str, &str)]) -> Output {
    api(args, env).output().unwrap()
}

fn said(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn migrated() -> String {
    let path = database();
    let output = run(&["migrate"], &[("NUXT_DATABASE", &path)]);
    assert!(output.status.success(), "{}", said(&output));
    path
}

#[test]
fn it_wont_start_without_the_shared_token() {
    let output = run(&[], &[("NUXT_DATABASE", &migrated())]);
    assert_eq!(output.status.code(), Some(1));
    assert!(said(&output).contains("set NUXT_API_TOKEN"), "{}", said(&output));
}

#[test]
fn it_wont_start_on_a_token_shorter_than_16_characters() {
    let output = run(&[], &[("NUXT_DATABASE", &migrated()), ("NUXT_API_TOKEN", "too-short")]);
    assert_eq!(output.status.code(), Some(1));
    assert!(said(&output).contains("16 characters or more"), "{}", said(&output));
}

#[test]
fn it_wont_start_without_a_database() {
    let output = run(&[], &[("NUXT_API_TOKEN", TOKEN)]);
    assert_eq!(output.status.code(), Some(1));
    assert!(said(&output).contains("set NUXT_DATABASE"), "{}", said(&output));
}

#[test]
fn it_wont_make_a_database_that_isnt_there() {
    let path = database();
    let output = run(&[], &[("NUXT_API_TOKEN", TOKEN), ("NUXT_DATABASE", &path)]);
    assert_eq!(output.status.code(), Some(1));
    assert!(said(&output).contains("can't open the database"), "{}", said(&output));
    assert!(!PathBuf::from(&path).exists(), "nothing made");
}

#[test]
fn it_wont_serve_a_database_its_migrations_havent_reached() {
    let path = database();
    std::fs::write(&path, b"").unwrap();
    let output = run(&[], &[("NUXT_API_TOKEN", TOKEN), ("NUXT_DATABASE", &path)]);
    assert_eq!(output.status.code(), Some(1));
    assert!(said(&output).contains("the database's schema is older than this API"), "{}", said(&output));
}

#[test]
fn migrate_says_where_it_took_the_schema_from_and_to_then_that_its_there() {
    let path = database();
    let first = run(&["migrate"], &[("NUXT_DATABASE", &path)]);
    assert!(first.status.success(), "{}", said(&first));
    let moved: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    let to = moved["to"].as_u64().unwrap();
    assert_eq!(moved["from"], 0);
    assert!(to > 0);
    assert!(said(&first).contains(&format!("migrated the schema from step 0 to {to}")), "{}", said(&first));

    let again = run(&["migrate"], &[("NUXT_DATABASE", &path)]);
    assert!(again.status.success(), "{}", said(&again));
    let stayed: serde_json::Value = serde_json::from_slice(&again.stdout).unwrap();
    assert_eq!(stayed, serde_json::json!({"from": to, "to": to}));
    assert!(said(&again).contains(&format!("the schema is at step {to} already")), "{}", said(&again));
}

#[test]
fn migrate_needs_a_database() {
    let output = run(&["migrate"], &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(said(&output).contains("set NUXT_DATABASE to the database to migrate"), "{}", said(&output));
}

#[test]
fn migrate_takes_nothing_anywhere_when_its_steps_end_elsewhere_than_the_callers() {
    let path = database();
    let output = run(&["migrate"], &[("NUXT_DATABASE", &path), ("ORRERY_API_STEPS", "1")]);
    assert_eq!(output.status.code(), Some(3));
    assert!(said(&output).contains("migrated nothing"), "{}", said(&output));
    assert!(!PathBuf::from(&path).exists(), "nothing made");
}

/// The API serving `path`, on a port of its own, and that port as its start line says it.
struct Serving(Child, String);

impl Drop for Serving {
    fn drop(&mut self) {
        self.0.kill().ok();
        self.0.wait().ok();
    }
}

fn serve(path: &str) -> Serving {
    let mut child =
        api(&[], &[("NUXT_API_TOKEN", TOKEN), ("NUXT_DATABASE", path), ("ORRERY_API_LISTEN", "127.0.0.1:0")]).stderr(Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stderr.take().unwrap()).read_line(&mut line).unwrap();
    // The Nuxt server (api-process.ts) and the parity tests read the port from this line: keep it as it is.
    let at = line.trim().strip_prefix("[orrery-api] serving docs on http://").and_then(|rest| rest.strip_suffix(", SQLite"));
    let at = at.unwrap_or_else(|| panic!("the start line: {line}")).to_string();
    Serving(child, at)
}

#[tokio::test]
async fn it_serves_on_the_port_its_start_line_names_and_answers_only_the_token() {
    let serving = serve(&migrated());
    let client = reqwest::Client::new();
    let health = client.get(format!("http://{}/health", serving.1)).send().await.unwrap();
    assert_eq!(health.status(), 200);
    assert_eq!(health.json::<serde_json::Value>().await.unwrap()["ok"], true);

    let without = client.get(format!("http://{}/api/projects", serving.1)).send().await.unwrap();
    assert_eq!(without.status(), 401, "no token, no answer");
    let wrong = client.get(format!("http://{}/api/projects", serving.1)).header("Orrery-API-Token", "not-the-token-at-all!!").send().await.unwrap();
    assert_eq!(wrong.status(), 401);
}
