// orrery's API in Rust (ORR-922), on the database the Nuxt server opens, and only to that server: which routes it
// serves is in routes/ (and the rust-api-parity doc), the domains they reach are board/, access/ and work/, and how the
// code is laid out is the rust-api-structure doc (ORR-1045). The Nuxt server's router (web/server/middleware/zz-api.ts)
// checks a request as it always has (auth, the board's permissions, the chat's and untrusted sessions' rails, the
// browser guards) and then forwards it here with who it's from, and each write is held to the same permissions table
// here too (access/rails.rs, ORR-1059). This listens on loopback, or on the playground's
// compose network (ORR-1051), and answers only a request that carries the token they share.
//
//   NUXT_API_TOKEN     the token they share, as the Nuxt server's setting of that name; required
//   NUXT_DATABASE      the database, as the Nuxt server's setting names it: a SQLite file or a postgres:// URL
//   ORRERY_API_LISTEN  where to listen; 127.0.0.1:9100 by default
//   ORRERY_API_SCHEMA  on Postgres, the schema to work in (the tests' own)
//   ORRERY_API_LOG     1: says each request it answers, and how
//   ORRERY_API_WAIT    1: until the database is there and migrated, tries again each second instead of exiting; for
//                      a container of its own that starts beside the Nuxt server's (the playground's, ORR-1051)
//
// `orrery-api migrate` brings NUXT_DATABASE's schema up to date instead (ORR-931), says `{"from":n,"to":m}` on stdout,
// and exits. The Nuxt server runs it before it opens a database, whenever it has this binary (server/utils/api-migrate.ts).
//   ORRERY_API_STEPS   the step the caller's own migrations end at: a build that ends anywhere else migrates nothing and
//                      exits 3, so a mismatched pair never takes a database somewhere the other can't follow
//   ORRERY_API_BACKUP_DIR, ORRERY_VERSION  where the copy before an upgrade goes, and the version it's named by
mod access;
mod board;
mod changes;
mod db;
mod error;
mod mcp;
mod migrate;
mod reply;
mod request;
mod routes;
mod steps;
#[cfg(test)]
mod testing;
mod text;
mod work;
mod write;

use axum::extract::{DefaultBodyLimit, State};
use axum::middleware;
use axum::routing::get;
use axum::{Json, Router};
use request::guard;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::AnyPool;
use std::sync::Arc;

struct App {
    pool: AnyPool,
    token: String,
    /// The database's setting, hashed: what the router sends, so a request for another database (the owner moved it in
    /// App settings, and this API wasn't restarted) is turned back rather than written to the old one.
    database: String,
    log: bool,
    /// The phone's one-time sign-in links (ORR-837), kept in memory as the Nuxt server keeps its own.
    phone: access::phone::Links,
    /// The MCP sessions `/mcp` has begun, and the tool groups each loaded (ORR-1167).
    mcp: mcp::sessions::Sessions,
}

type Shared = State<Arc<App>>;

fn database_hash(setting: &str) -> String {
    Sha256::digest(setting.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// `GET /health`: that the API is up, for the local app that starts it and waits for it. It needs no token, so it says
/// nothing else (ORR-1170).
async fn health() -> Json<Value> {
    Json(json!({"ok": true}))
}

fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/health", get(health))
        // Each write held to its rails first (ORR-1059), once it's a route this API has.
        .merge(routes::all().route_layer(middleware::from_fn_with_state(app.clone(), access::rails::rails)))
        // What a body may be, as the Nuxt server's big-bodies.ts has it (ORR-1062). A route that takes more reads its own.
        .layer(DefaultBodyLimit::max(request::BODY_LIMIT))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

#[tokio::main]
async fn main() {
    let fail = |message: String| -> ! {
        eprintln!("[orrery-api] {message}");
        std::process::exit(1)
    };
    if std::env::args().nth(1).as_deref() == Some("migrate") {
        let setting =
            std::env::var("NUXT_DATABASE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| fail("set NUXT_DATABASE to the database to migrate".into()));
        let latest = migrate::latest(if db::is_postgres(&setting) { migrate::Dialect::Postgres } else { migrate::Dialect::Sqlite });
        if let Some(expected) = std::env::var("ORRERY_API_STEPS").ok().filter(|s| !s.is_empty()) {
            if expected != latest.to_string() {
                eprintln!("[orrery-api] this build's migrations end at schema step {latest}, not {expected}: migrated nothing");
                std::process::exit(3)
            }
        }
        let done = migrate::migrate(&setting, std::env::var("ORRERY_API_SCHEMA").ok().as_deref()).await.unwrap_or_else(|e| fail(e));
        println!("{}", json!({"from": done.from, "to": done.to}));
        if done.from == done.to {
            eprintln!("[orrery-api] the schema is at step {} already", done.to);
        } else {
            eprintln!("[orrery-api] migrated the schema from step {} to {}", done.from, done.to);
        }
        return;
    }
    let token = std::env::var("NUXT_API_TOKEN")
        .ok()
        .filter(|t| t.len() >= 16)
        .unwrap_or_else(|| fail("set NUXT_API_TOKEN (16 characters or more), the same as the Nuxt server's".into()));
    let setting =
        std::env::var("NUXT_DATABASE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| fail("set NUXT_DATABASE to the database the Nuxt server opens".into()));
    let listen = std::env::var("ORRERY_API_LISTEN").unwrap_or_else(|_| "127.0.0.1:9100".into());
    let wait = std::env::var("ORRERY_API_WAIT").is_ok_and(|v| v == "1");
    let mut said = false;
    let pool = loop {
        match db::open(&setting, std::env::var("ORRERY_API_SCHEMA").ok()).await {
            Ok(pool) => break pool,
            Err(e) if wait => {
                if !said {
                    eprintln!("[orrery-api] {e}; trying again each second until it's there (ORRERY_API_WAIT)");
                    said = true;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(e) => fail(e),
        }
    };
    // A SQLite file as the Nuxt server names it (`databaseSetting`): its whole path.
    let named = if db::is_postgres(&setting) {
        setting.clone()
    } else {
        std::path::absolute(&setting).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|e| fail(format!("can't place {setting}: {e}")))
    };
    // The outbox keeps a week (ORR-929): pruned now, then hourly.
    let pruning = pool.clone();
    tokio::spawn(async move {
        loop {
            changes::prune(&pruning).await.ok();
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
    let app = Arc::new(App {
        pool,
        token,
        database: database_hash(&named),
        log: std::env::var("ORRERY_API_LOG").is_ok_and(|v| v == "1"),
        phone: access::phone::Links::default(),
        mcp: mcp::sessions::Sessions::default(),
    });
    let listener = tokio::net::TcpListener::bind(&listen).await.unwrap_or_else(|e| fail(format!("can't listen on {listen}: {e}")));
    let at = listener.local_addr().map(|a| a.to_string()).unwrap_or(listen);
    eprintln!("[orrery-api] serving docs on http://{at}, {}", if db::is_postgres(&setting) { "Postgres" } else { "SQLite" });
    axum::serve(listener, router(app))
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await
        .unwrap_or_else(|e| fail(e.to_string()));
}
