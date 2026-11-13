// Copies the whole orrery this API runs on into another database, SQLite or Postgres (ORR-1134), as
// web/server/utils/copy.ts does for the local app: the database move in App settings copies into an empty one, and a
// Postgres backup takes the place of the last. Every table is read in one transaction, so what's copied is one
// moment's, then written in order, ids kept, in one transaction. The target is brought up to the latest schema first,
// and must have no projects unless `replace` empties it in that same transaction (a backup taking the place of the
// last, which stays whole if this one fails).
use crate::db::is_postgres;
use crate::migrate;
use sqlx::any::AnyTypeInfoKind;
use sqlx::{AnyConnection, AnyPool, Connection, Row, ValueRef};
use std::collections::HashMap;

/// In an order every foreign key is satisfied in, the statuses first (issues point at them): `COPIED_TABLES` in copy.ts.
pub const COPIED_TABLES: [&str; 49] = [
    "statuses",
    "settings",
    "people",
    "workspaces",
    "workspace_members",
    "keys",
    "logins",
    "identities",
    "invites",
    "projects",
    "project_members",
    "releases",
    "milestones",
    "epics",
    "issues",
    "comments",
    "milestone_comments",
    "epic_comments",
    "notice_clears",
    "notice_reads",
    "schedule_requests",
    "issue_events",
    "issue_sessions",
    "issue_pulls",
    "session_people",
    "issue_aliases",
    "issue_links",
    "milestone_aliases",
    "docs",
    "doc_sections",
    "doc_revisions",
    "schedules_across",
    "schedules",
    "schedule_runs",
    "schedule_held",
    "signals",
    "secrets",
    "secret_uses",
    "uploads",
    "presets",
    "preset_defaults",
    "events",
    "changes",
    "proposal_clears",
    "pull_states",
    "pull_repos",
    "chats",
    "chat_messages",
    "feature_use",
];

/// The tables whose ids the database hands out, so Postgres's counters move on past the copied ones.
const NUMBERED: [&str; 14] = [
    "epics",
    "comments",
    "milestone_comments",
    "epic_comments",
    "issue_events",
    "doc_revisions",
    "schedules_across",
    "schedules",
    "schedule_runs",
    "signals",
    "secret_uses",
    "presets",
    "events",
    "changes",
];

/// What a new database starts with that the source's replace: the default statuses and workspace, and the presets
/// orrery ships, if they were seeded.
const STARTS_WITH: [&str; 7] = ["statuses", "settings", "workspace_members", "workspaces", "people", "presets", "preset_defaults"];

/// One value as read, to write again in either dialect.
#[derive(Clone, Debug)]
enum Cell {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

type Table = (Vec<String>, Vec<Vec<Cell>>);

/// Why a copy didn't happen: the target can't be reached or isn't empty (a 409), or it failed partway (a 500, and
/// nothing of it landed).
#[derive(Debug)]
pub enum CopyError {
    NotEmpty,
    Failed(String),
}

impl From<sqlx::Error> for CopyError {
    fn from(error: sqlx::Error) -> Self {
        CopyError::Failed(error.to_string())
    }
}

/// Copies what `source` holds into the database `to` names (a SQLite file's path, made if it isn't there, or a
/// `postgres://` URL), and says how many rows of each table it copied. `mark` is written into the target's settings
/// as `backup_of`: the id of the orrery it's a backup of.
pub async fn copy_into(source: &AnyPool, to: &str, replace: bool, mark: Option<&str>) -> Result<Vec<(&'static str, usize)>, CopyError> {
    migrate::migrate(to, None).await.map_err(CopyError::Failed)?;
    let postgres = is_postgres(to);
    let url = if postgres { to.to_string() } else { format!("sqlite://{to}?mode=rw") };
    let mut target = AnyConnection::connect(&url).await?;
    if !postgres {
        sqlx::raw_sql("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON").execute(&mut target).await?;
    }
    if !replace {
        let projects: i64 = sqlx::query("SELECT count(*) AS n FROM projects").fetch_one(&mut target).await?.try_get("n")?;
        if projects > 0 {
            return Err(CopyError::NotEmpty);
        }
    }
    let rows = read_all(source).await?;
    let types = if postgres { column_types(&mut target).await? } else { HashMap::new() };
    let mut tx = target.begin().await?;
    sqlx::raw_sql(if postgres { "SET CONSTRAINTS ALL DEFERRED" } else { "PRAGMA defer_foreign_keys = ON" }).execute(&mut *tx).await?;
    if replace {
        for table in COPIED_TABLES.iter().rev() {
            sqlx::query(&format!("DELETE FROM {table}")).execute(&mut *tx).await?;
        }
    }
    for table in STARTS_WITH {
        sqlx::query(&format!("DELETE FROM {table}")).execute(&mut *tx).await?;
    }
    let mut copied = Vec::with_capacity(COPIED_TABLES.len());
    for (table, (columns, values)) in COPIED_TABLES.iter().zip(rows) {
        if !values.is_empty() {
            let statement = insert(table, &columns, postgres.then_some(&types));
            for row in &values {
                let mut query = sqlx::query(&statement);
                for cell in row {
                    query = match cell {
                        Cell::Null => query.bind(None::<String>),
                        Cell::Int(n) => query.bind(*n),
                        Cell::Real(n) => query.bind(*n),
                        Cell::Text(text) => query.bind(text.clone()),
                        Cell::Blob(bytes) => query.bind(bytes.clone()),
                    };
                }
                query.execute(&mut *tx).await?;
            }
        }
        copied.push((*table, values.len()));
    }
    // Over the source's own, if it was started from a backup.
    if let Some(mark) = mark {
        let statement = "INSERT INTO settings (key, value) VALUES ('backup_of', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
        sqlx::query(&numbered(statement, postgres)).bind(serde_json::Value::String(mark.to_string()).to_string()).execute(&mut *tx).await?;
    }
    if postgres {
        for table in NUMBERED {
            sqlx::query(&format!("SELECT setval(pg_get_serial_sequence('{table}', 'id'), coalesce((SELECT max(id) FROM {table}), 0) + 1, false)"))
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(copied)
}

/// Every table, in one transaction (on Postgres one snapshot of it), so a write while it copies a running orrery
/// can't leave a row pointing at one that isn't there.
async fn read_all(source: &AnyPool) -> Result<Vec<Table>, CopyError> {
    let mut tx = source.begin().await?;
    if crate::db::on_postgres() {
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").execute(&mut *tx).await?;
    }
    let mut tables = Vec::with_capacity(COPIED_TABLES.len());
    for table in COPIED_TABLES {
        let rows = sqlx::query(&format!("SELECT * FROM {table}")).fetch_all(&mut *tx).await?;
        let columns: Vec<String> = rows.first().map(|row| row.columns().iter().map(|c| sqlx::Column::name(c).to_string()).collect()).unwrap_or_default();
        let mut values = Vec::with_capacity(rows.len());
        for row in &rows {
            values.push((0..columns.len()).map(|i| cell(row, i)).collect::<Result<Vec<_>, _>>()?);
        }
        tables.push((columns, values));
    }
    tx.commit().await?;
    Ok(tables)
}

/// A value as it's stored, whatever the column says (SQLite keeps what it's given).
fn cell(row: &sqlx::any::AnyRow, i: usize) -> Result<Cell, CopyError> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(Cell::Null);
    }
    let kind = raw.type_info().kind();
    Ok(match kind {
        AnyTypeInfoKind::Bool => Cell::Int(row.try_get::<bool, _>(i)? as i64),
        AnyTypeInfoKind::SmallInt | AnyTypeInfoKind::Integer | AnyTypeInfoKind::BigInt => Cell::Int(row.try_get::<i64, _>(i)?),
        AnyTypeInfoKind::Real | AnyTypeInfoKind::Double => Cell::Real(row.try_get::<f64, _>(i)?),
        AnyTypeInfoKind::Text => Cell::Text(row.try_get::<String, _>(i)?),
        AnyTypeInfoKind::Blob => Cell::Blob(row.try_get::<Vec<u8>, _>(i)?),
        AnyTypeInfoKind::Null => Cell::Null,
    })
}

/// Each Postgres column's type, by table and column: each value is cast to it, as a value read from SQLite (an
/// integer, a text, a null) is bound as its own type, and Postgres takes only some of those into another.
async fn column_types(conn: &mut AnyConnection) -> Result<HashMap<(String, String), String>, CopyError> {
    let rows = sqlx::query(
        "SELECT table_name::text AS t, column_name::text AS c, data_type::text AS d FROM information_schema.columns WHERE table_schema = current_schema()",
    )
    .fetch_all(conn)
    .await?;
    let mut types = HashMap::new();
    for row in rows {
        types.insert((row.try_get::<String, _>("t")?, row.try_get::<String, _>("c")?), row.try_get::<String, _>("d")?);
    }
    Ok(types)
}

/// The insert for a row of `table`, each value cast to its column's type on Postgres.
fn insert(table: &str, columns: &[String], types: Option<&HashMap<(String, String), String>>) -> String {
    let quoted: Vec<String> = columns.iter().map(|c| format!("\"{}\"", c.replace('"', ""))).collect();
    let values: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(i, column)| match types {
            Some(types) => match types.get(&(table.to_string(), column.clone())) {
                Some(kind) => format!("${}::{kind}", i + 1),
                None => format!("${}", i + 1),
            },
            None => "?".to_string(),
        })
        .collect();
    format!("INSERT INTO {table} ({}) VALUES ({})", quoted.join(", "), values.join(", "))
}

/// `?` numbered for Postgres (`$1`), as `db::sql` does for the API's own database, here for the target's dialect.
fn numbered(text: &str, postgres: bool) -> String {
    if !postgres {
        return text.to_string();
    }
    let mut n = 0;
    text.chars()
        .map(|c| {
            if c == '?' {
                n += 1;
                format!("${n}")
            } else {
                c.to_string()
            }
        })
        .collect()
}
