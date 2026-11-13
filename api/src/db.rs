// The database: the same SQLite file or Postgres the Nuxt server opens, already migrated by `orrery-api migrate`
// (migrate.rs), which the Nuxt server runs before it opens it (ORR-931). Serving, this API runs no migrations, and
// refuses to start on one that lacks what it reads.
use sqlx::any::{install_default_drivers, AnyPoolOptions};
use sqlx::{AnyPool, Executor};
use std::sync::OnceLock;

/// What the docs domain, the statuses, the issue, comment and activity reads and the people, keys and logins, the secrets, the settings and a pull request's read take, each a query that fails on a schema without it. Checked by the columns rather than a
/// schema version, as SQLite's and Postgres's steps are counted differently.
const NEEDS: [&str; 24] = [
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
    "SELECT id, project, issue, field, \"before\", \"after\", created_by, session_name, owned, created_at FROM issue_events WHERE 1 = 0",
    "SELECT id, name, role, created_at, removed_at FROM people WHERE 1 = 0",
    "SELECT id, person, kind, name, hash, created_at, last_used_at, revoked_at FROM keys WHERE 1 = 0",
    "SELECT id, person, expires_at, by_key, known, name, created_at, last_used_at FROM logins WHERE 1 = 0",
    "SELECT name, last4, hosts, projects, created_by, created_at, updated_at FROM secrets WHERE 1 = 0",
    "SELECT id, secret, method, host, path, project, issue, status, error, created_by, created_at FROM secret_uses WHERE 1 = 0",
    "SELECT id, kind, project, subject, actor, owner, session, untrusted, cause, payload, created_at FROM changes WHERE 1 = 0",
    "SELECT key, value FROM settings WHERE 1 = 0",
    "SELECT project, issue, repo, number, title, url, branch, base, author, state, merged_at, updated_at, risk, risk_why, risk_by FROM issue_pulls WHERE 1 = 0",
    "SELECT cleared, was_read FROM comments WHERE 1 = 0",
    "SELECT comment, person FROM notice_clears WHERE 1 = 0",
    "SELECT comment, person FROM notice_reads WHERE 1 = 0",
    "SELECT project, issue, put_up, cleared_at FROM proposal_clears WHERE 1 = 0",
];

static POSTGRES: OnceLock<bool> = OnceLock::new();

pub fn on_postgres() -> bool {
    *POSTGRES.get().unwrap_or(&false)
}

/// SQL written with `?`, as the Nuxt server writes it for both; Postgres numbers them (`$1, $2, …`).
pub fn sql(text: &str) -> String {
    if !on_postgres() {
        return text.to_string();
    }
    numbered(text)
}

/// Where `numbered` is in the SQL it reads.
#[derive(PartialEq)]
enum In {
    Code,
    Text,
    Name,
    LineComment,
    BlockComment,
}

/// Each `?` numbered in turn, leaving alone a `?` in quoted text (`'…'`), a quoted name (`"…"`) or a comment (`--…`,
/// `/*…*/`), where it's not a placeholder (ORR-1166). A doubled quote inside one (`'it''s'`) closes and reopens it,
/// which leaves it inside.
fn numbered(text: &str) -> String {
    let (mut n, mut at, mut out) = (0, In::Code, String::with_capacity(text.len() + 8));
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let next = chars.peek().copied();
        at = match (&at, c, next) {
            (In::Code, '?', _) => {
                n += 1;
                out.push_str(&format!("${n}"));
                continue;
            }
            (In::Code, '\'', _) => In::Text,
            (In::Code, '"', _) => In::Name,
            (In::Code, '-', Some('-')) => In::LineComment,
            (In::Code, '/', Some('*')) => {
                out.push(c);
                out.push(chars.next().unwrap_or('*'));
                at = In::BlockComment;
                continue;
            }
            (In::Text, '\'', _) | (In::Name, '"', _) | (In::LineComment, '\n', _) => In::Code,
            (In::BlockComment, '*', Some('/')) => {
                out.push(c);
                out.push(chars.next().unwrap_or('/'));
                at = In::Code;
                continue;
            }
            _ => at,
        };
        out.push(c)
    }
    out
}

#[cfg(test)]
#[path = "db_tests.rs"]
mod tests;

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
        // A write opens its transaction with `BEGIN` (changes::begin), which sqlx doesn't see. When its request is cut off
        // between that and `COMMIT`, the future is dropped and the connection comes back here still inside it, holding
        // SQLite's write lock (ORR-1164). So each one is rolled back on its way in. Outside a transaction that's a no-op:
        // SQLite refuses it, and Postgres warns.
        .after_release(|conn, _| {
            Box::pin(async move {
                conn.execute("ROLLBACK").await.ok();
                Ok(true)
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
