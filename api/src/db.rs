// The database: the same SQLite file or Postgres the Nuxt server opens, already migrated by it. Serving, this API runs
// no migrations (web/server/utils/migrations stay the schema's source until the last domain has moved; `orrery-api
// migrate`, migrate.rs, is their port, which nothing runs yet), and refuses to start on one that lacks what it reads.
use sqlx::any::{install_default_drivers, AnyPoolOptions};
use sqlx::{AnyPool, Executor};
use std::sync::OnceLock;

/// What the docs domain, the statuses and the comment reads take, each a query that fails on a schema without it. Checked by the columns rather than a
/// schema version, as SQLite's and Postgres's steps are counted differently.
const NEEDS: [&str; 11] = [
    "SELECT uid, doc_section_order, updated_at FROM projects WHERE 1 = 0",
    "SELECT project, id, title, body, kind, position, section, created_by, owned, created_at, updated_at FROM docs WHERE 1 = 0",
    "SELECT project, name, created_at FROM doc_sections WHERE 1 = 0",
    "SELECT id, project, doc, title, body, kind, section, deleted, created_by, session_name, owned, created_at FROM doc_revisions WHERE 1 = 0",
    "SELECT id, project, issue, body, asks, created_by, session_name, owned, person, by_agent, created_at, updated_at FROM comments WHERE 1 = 0",
    "SELECT project, alias, issue FROM issue_aliases WHERE 1 = 0",
    "SELECT comment, schedule, title, changes, body, state FROM schedule_requests WHERE 1 = 0",
    "SELECT id, name, kind, color, position FROM statuses WHERE 1 = 0",
    "SELECT status FROM issues WHERE 1 = 0",
    "SELECT place, move_from FROM schedules WHERE 1 = 0",
    "SELECT status FROM signals WHERE 1 = 0",
];

static POSTGRES: OnceLock<bool> = OnceLock::new();

pub fn on_postgres() -> bool {
    *POSTGRES.get().unwrap_or(&false)
}

/// SQL written with `?`, as the Nuxt server writes it for both; Postgres numbers them (`$1, $2, …`), leaving quoted
/// text alone, as `numbered` in web/server/utils/postgres.ts does.
pub fn sql(text: &str) -> String {
    if !on_postgres() {
        return text.to_string();
    }
    let (mut n, mut quoted, mut out) = (0, false, String::with_capacity(text.len() + 8));
    for c in text.chars() {
        if c == '\'' {
            quoted = !quoted
        }
        if c == '?' && !quoted {
            n += 1;
            out.push_str(&format!("${n}"))
        } else {
            out.push(c)
        }
    }
    out
}

pub fn is_postgres(setting: &str) -> bool {
    setting.starts_with("postgres://") || setting.starts_with("postgresql://")
}

/// Opens `setting`, a SQLite file's path or a `postgres://` URL, as the Nuxt server's `NUXT_DATABASE` names it.
/// `schema`, on Postgres, is the one to work in (the tests' own, as web/test/db.ts makes them).
pub async fn open(setting: &str, schema: Option<String>) -> Result<AnyPool, String> {
    install_default_drivers();
    let postgres = is_postgres(setting);
    POSTGRES.set(postgres).ok();
    let url = if postgres { setting.to_string() } else { format!("sqlite://{setting}?mode=rw") };
    let pool = AnyPoolOptions::new()
        .max_connections(if postgres { 8 } else { 4 })
        .after_connect(move |conn, _| {
            let schema = schema.clone();
            Box::pin(async move {
                if postgres {
                    if let Some(schema) = schema {
                        conn.execute(format!("SET search_path TO \"{}\"", schema.replace('"', "")).as_str()).await?;
                    }
                } else {
                    // As the Nuxt server opens it: wait for its writes rather than fail on them.
                    conn.execute("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON").await?;
                }
                Ok(())
            })
        })
        .connect(&url)
        .await
        .map_err(|e| format!("can't open the database: {e}"))?;
    for need in NEEDS {
        sqlx::query(need)
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("the database's schema is older than this API ({e}): start the Nuxt server on it first, which migrates it"))?;
    }
    Ok(pool)
}
