// What the API's own tests stand on (ORR-1053): a fresh SQLite file migrated by this API's migrations, an `App` on it,
// and requests sent through `router()`, guard and all, as the Nuxt router in front sends them. No Node and no Nuxt
// server: the parity tests (web/test/api-parity.test.ts) prove the replies match Nuxt's; these prove what the API does.
// A fresh database has a `uid` setting and no people; a new issue starts in `backlog`. The `orrery-*` headers come
// percent-encoded (`doc%2Ecreated`), as `reply.rs` writes them.
//
//     let api = TestApi::new().await;
//     let project = api.project("Primes").await;
//     let reply = api.post(&format!("/api/projects/{project}/docs"), json!({"title": "Plan"})).send().await;
//     assert_eq!(reply.status, 201);
//
// The helpers the route tests share live here too, once (ORR-1056): people put straight in the table (`owner`,
// `member`, `team`), who a request is from (`agent_of`, `browser`, …), what a reply said (`told`, `problems`,
// `changed`, `ids`) and what the database holds (`count`, `outbox`).
use crate::db::sql;
use crate::write::stamp;
use crate::{access, database_hash, db, migrate, router, App};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use sqlx::Row;
use std::sync::Arc;
use tower::ServiceExt;

/// The token the tests' router and API share.
fn random_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_of(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) const TOKEN: &str = "a-test-token-of-32-characters!!!";

pub(crate) struct TestApi {
    pub(crate) app: Arc<App>,
    router: Router,
    came: &'static str,
}

impl TestApi {
    /// A new orrery on a database of its own, migrated to the latest step: a SQLite file, or with `TEST_POSTGRES_URL`
    /// set, a schema of its own there (ORR-1057), as web/test/db.ts makes them for the Nuxt server's tests.
    pub(crate) async fn new() -> TestApi {
        let id = random_id();
        let (setting, schema) = match std::env::var("TEST_POSTGRES_URL") {
            Ok(url) if !url.is_empty() => (url, Some(format!("api_test_{id}"))),
            _ => {
                let dir = std::env::temp_dir().join(format!("orrery-api-test-{id}"));
                std::fs::create_dir_all(&dir).unwrap();
                (dir.join("orrery.db").to_string_lossy().into_owned(), None)
            }
        };
        migrate::migrate(&setting, schema.as_deref()).await.expect("the API's migrations make a database");
        let pool = db::open(&setting, schema.clone()).await.expect("the API opens the database it migrated");
        // Each test's database is its own, so its hash is too: on Postgres the URL is shared, the schema isn't.
        let database = database_hash(&format!("{setting}#{}", schema.unwrap_or_default()));
        let app = Arc::new(App { pool, token: TOKEN.into(), database, log: false, phone: access::phone::Links::default() });
        TestApi { router: router(app.clone()), app, came: "server" }
    }

    /// Like `new`, but each request comes as one from outside would, over loopback, so the guard checks its login
    /// (ORR-1038). `new`'s come as the Nuxt server's own work (`Orrery-Came: server`), which says who it's for itself.
    pub(crate) async fn at_the_door() -> TestApi {
        TestApi { came: "loopback", ..TestApi::new().await }
    }

    /// A browser's login for `person`, as `Orrery-Login` sends it: the cookie's secret hashed.
    pub(crate) async fn login(&self, person: &str) -> String {
        let hash = hash_of(&format!("login-{}", random_id()));
        let expires = (chrono::Utc::now() + chrono::Duration::days(30)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        sqlx::query(&db::sql("INSERT INTO logins (id, person, expires_at, known, created_at, last_used_at) VALUES (?, ?, ?, 1, ?, ?)"))
            .bind(&hash)
            .bind(person)
            .bind(expires)
            .bind(crate::write::stamp())
            .bind(crate::write::stamp())
            .execute(&self.app.pool)
            .await
            .unwrap();
        hash
    }

    /// A key of `kind` (`agent` or `person`) for `person`, as `Orrery-Key` sends a bearer: the key hashed.
    pub(crate) async fn key(&self, person: &str, kind: &str) -> String {
        let id = random_id();
        let hash = hash_of(&format!("key-{id}"));
        sqlx::query(&db::sql("INSERT INTO keys (id, person, kind, name, hash, created_at) VALUES (?, ?, ?, 'test', ?, ?)"))
            .bind(id)
            .bind(person)
            .bind(kind)
            .bind(&hash)
            .bind(crate::write::stamp())
            .execute(&self.app.pool)
            .await
            .unwrap();
        hash
    }

    /// A request as the owner sends it through the router: the token, this database, and the owner as the actor.
    pub(crate) fn request(&self, method: Method, path: &str) -> Req {
        Req { router: self.router.clone(), method, path: path.into(), body: None, headers: vec![] }
            .header("orrery-api-token", TOKEN)
            .header("orrery-database", &self.app.database)
            .header("orrery-actor-name", "owner")
            .header("orrery-actor-owner", "1")
            .header("orrery-came", self.came)
    }

    pub(crate) fn get(&self, path: &str) -> Req {
        self.request(Method::GET, path)
    }

    pub(crate) fn post(&self, path: &str, body: Value) -> Req {
        self.request(Method::POST, path).json(body)
    }

    pub(crate) fn patch(&self, path: &str, body: Value) -> Req {
        self.request(Method::PATCH, path).json(body)
    }

    pub(crate) fn put(&self, path: &str, body: Value) -> Req {
        self.request(Method::PUT, path).json(body)
    }

    pub(crate) fn delete(&self, path: &str) -> Req {
        self.request(Method::DELETE, path)
    }

    /// Makes a project named `name` as the owner, and gives back its id.
    pub(crate) async fn project(&self, name: &str) -> String {
        let reply = self.post("/api/projects", json!({"name": name})).send().await;
        assert_eq!(reply.status, 201, "making project {name}: {}", reply.body);
        reply.body["id"].as_str().expect("a project's id").to_string()
    }

    /// Makes an issue on `project` as the owner, from `body` (`{"title": …}` at least), and gives back its id.
    pub(crate) async fn issue(&self, project: &str, body: Value) -> String {
        let reply = self.post(&format!("/api/projects/{project}/issues"), body).send().await;
        assert_eq!(reply.status, 201, "making an issue: {}", reply.body);
        reply.body["id"].as_str().expect("an issue's id").to_string()
    }

    /// Project Primes with an issue on it, Sieve: their ids.
    pub(crate) async fn board(&self) -> (String, String) {
        let project = self.project("Primes").await;
        let issue = self.issue(&project, json!({"title": "Sieve"})).await;
        (project, issue)
    }

    /// The owner, `steffen` named Steffen, as `PUT /api/owner` would leave them.
    pub(crate) async fn owner(&self) {
        self.run("INSERT INTO people (id, name, role, created_at) VALUES ('steffen', 'Steffen', 'owner', ?)", &[&stamp()]).await;
    }

    /// A member, put straight in the table (no way-in check).
    pub(crate) async fn member(&self, id: &str, name: &str) {
        self.run("INSERT INTO people (id, name, role, created_at) VALUES (?, ?, 'member', ?)", &[id, name, &stamp()]).await;
    }

    /// The owner, `steffen`, and two members, `ana` and `bo`: with more than one person the rails hold.
    pub(crate) async fn team(&self) {
        for (id, role) in [("steffen", "owner"), ("ana", "member"), ("bo", "member")] {
            self.run("INSERT INTO people (id, name, role, created_at) VALUES (?, ?, ?, ?)", &[id, id, role, STAMP]).await;
        }
    }

    /// Runs a statement on the database, for what no route sets (a claim another session holds).
    pub(crate) async fn run(&self, statement: &str, binds: &[&str]) {
        let statement = sql(statement);
        let mut query = sqlx::query(&statement);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(&self.app.pool).await.unwrap();
    }

    /// The number a query gives back, as `SELECT count(*) FROM people`.
    pub(crate) async fn count(&self, query: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(query).fetch_one(&self.app.pool).await.unwrap()
    }

    /// The outbox's rows, oldest first.
    pub(crate) async fn outbox(&self) -> Vec<Change> {
        let rows = sqlx::query("SELECT kind, project, subject, payload FROM changes ORDER BY id").fetch_all(&self.app.pool).await.unwrap();
        rows.iter().map(|r| Change { kind: r.get("kind"), project: r.get("project"), subject: r.get("subject"), payload: r.get("payload") }).collect()
    }
}

/// When `team` says its people joined (`owner` and `member` say now, so they list in the order they were put in).
const STAMP: &str = "2026-11-01T00:00:00.000Z";

/// An outbox row.
#[derive(Debug)]
pub(crate) struct Change {
    pub(crate) kind: String,
    pub(crate) project: Option<String>,
    pub(crate) subject: Option<String>,
    pub(crate) payload: Option<String>,
}

impl Change {
    /// `<kind> <project> <subject>`, leaving out what it hasn't.
    pub(crate) fn line(&self) -> String {
        let part = |p: &Option<String>| p.clone().unwrap_or_default();
        format!("{} {} {}", self.kind, part(&self.project), part(&self.subject)).trim_end().to_string()
    }

    /// Its payload, as JSON.
    pub(crate) fn payload(&self) -> Value {
        serde_json::from_str(self.payload.as_deref().expect("a payload")).unwrap()
    }
}

/// The `id` of each entry in a list a route gave back.
pub(crate) fn ids(list: &Value) -> Vec<String> {
    list.as_array().expect("a list").iter().map(|entry| entry["id"].as_str().expect("an id").to_string()).collect()
}

/// A request being made: change who it's from with `header`, then `send` it.
pub(crate) struct Req {
    router: Router,
    method: Method,
    path: String,
    body: Option<Value>,
    headers: Vec<(String, String)>,
}

impl Req {
    /// Sets a header, replacing one of the same name.
    pub(crate) fn header(mut self, name: &str, value: &str) -> Req {
        self.headers.retain(|(n, _)| !n.eq_ignore_ascii_case(name));
        self.headers.push((name.to_ascii_lowercase(), value.into()));
        self
    }

    /// Leaves a header out.
    pub(crate) fn without(mut self, name: &str) -> Req {
        self.headers.retain(|(n, _)| !n.eq_ignore_ascii_case(name));
        self
    }

    pub(crate) fn json(mut self, body: Value) -> Req {
        self.body = Some(body);
        self
    }

    /// From an agent rather than the owner: `name`, with no owner flag.
    pub(crate) fn by_agent(self, name: &str) -> Req {
        self.header("orrery-actor-name", name).without("orrery-actor-owner")
    }

    // Who's asking, as the router sends it (`actor_of`).

    /// An agent's request on the rails (`Orrery-Actor-Asked: 1`), its session naming `person`.
    pub(crate) fn agent_of(self, person: &str) -> Req {
        self.agent_of_nobody().header("orrery-actor-named", person)
    }

    /// An agent's request on the rails whose session names nobody here.
    pub(crate) fn agent_of_nobody(self) -> Req {
        self.by_agent("claude").header("orrery-actor-asked", "1")
    }

    /// An untrusted session's request (`Orrery-Actor-Kind: untrusted`).
    pub(crate) fn untrusted(self) -> Req {
        self.by_agent("outsider").header("orrery-actor-asked", "1").header("orrery-actor-kind", "untrusted")
    }

    /// A person's own request on the rails: `person`, not the owner.
    pub(crate) fn person(self, person: &str) -> Req {
        self.by_agent(person).header("orrery-actor-person", person).header("orrery-actor-asked", "1")
    }

    /// From a browser signed in with `login` (`TestApi::login`), the cookie hashed as the router sends it. The guard
    /// looks it up on an orrery `at_the_door`.
    pub(crate) fn signed_in(self, login: &str) -> Req {
        self.header("orrery-login", login)
    }

    /// As the router says a person signed in to the page is asking: taken only from the Nuxt server's own calls
    /// (`TestApi::new`), as the guard finds who's asking itself otherwise (ORR-1038).
    pub(crate) fn browser(self, person: &str, owner: bool) -> Req {
        self.header("orrery-who", "browser").header("orrery-who-person", person).header("orrery-who-owner", if owner { "1" } else { "0" })
    }

    /// As the router sends a request made with an agent key of `person`.
    pub(crate) fn agent_key(self, person: &str, owner: bool) -> Req {
        self.header("orrery-who", "agent").header("orrery-who-person", person).header("orrery-who-owner", if owner { "1" } else { "0" })
    }

    /// A member signed in to their own page: the router names them, never the owner.
    pub(crate) fn member_browser(self, person: &str) -> Req {
        self.header("orrery-actor-name", person).without("orrery-actor-owner").browser(person, false)
    }

    pub(crate) async fn send(self) -> Reply {
        let mut request = Request::builder().method(self.method).uri(&self.path);
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let request = match self.body {
            Some(body) => request.header("content-type", "application/json").body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = self.router.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().iter().map(|(n, v)| (n.as_str().to_string(), v.to_str().unwrap_or_default().to_string())).collect();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))) };
        Reply { status, headers, body }
    }
}

/// What came back: its status, headers (names lowercased) and body, as JSON when it was.
#[derive(Debug)]
pub(crate) struct Reply {
    pub(crate) status: StatusCode,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Value,
}

impl Reply {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    /// A header's list, each entry percent-decoded: `issue.priority primes PRI-1 ~ P0`.
    pub(crate) fn said(&self, name: &str) -> Vec<String> {
        let decode = |part: &str| percent_decode_str(part).decode_utf8_lossy().into_owned();
        self.header(name).map(|all| all.split(", ").filter(|one| !one.is_empty()).map(decode).collect()).unwrap_or_default()
    }

    /// The events a write told (`Orrery-Told`), each in turn: `doc.created primes plan`.
    pub(crate) fn told(&self) -> Vec<String> {
        self.said("orrery-told")
    }

    /// The projects a write changed (`Orrery-Changed`), sorted.
    pub(crate) fn changed(&self) -> Vec<String> {
        let mut projects = self.said("orrery-changed");
        projects.sort();
        projects
    }

    /// The problems a 400 lists.
    pub(crate) fn problems(&self) -> Vec<String> {
        self.body["data"]["problems"].as_array().map(|p| p.iter().map(|p| p.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_needs_no_token() {
        let api = TestApi::new().await;
        let reply = api.get("/health").without("orrery-api-token").send().await;
        assert_eq!(reply.status, 200);
    }

    #[tokio::test]
    async fn a_request_without_the_token_is_turned_away() {
        let api = TestApi::new().await;
        let reply = api.get("/api/statuses").without("orrery-api-token").send().await;
        assert_eq!(reply.status, 401);
        let wrong = api.get("/api/statuses").header("orrery-api-token", "a-test-token-of-32-characters!!?").send().await;
        assert_eq!(wrong.status, 401);
    }

    #[tokio::test]
    async fn a_request_for_another_database_is_turned_away() {
        let api = TestApi::new().await;
        let reply = api.get("/api/statuses").header("orrery-database", "another").send().await;
        assert_eq!(reply.status, 421);
    }

    #[tokio::test]
    async fn makes_a_project() {
        let api = TestApi::new().await;
        let id = api.project("Primes").await;
        let listed = api.get("/api/projects").send().await;
        assert_eq!(listed.status, 200);
        assert!(listed.body.as_array().unwrap().iter().any(|p| p["id"] == json!(id)), "{}", listed.body);
    }
}
