// One board as one file (ORR-668, moved in ORR-1006): a snapshot of a project, read in one transaction, that leaves the
// board where it is, as web/server/utils/board-export.ts makes it. The tables and which rows of each are its `EXPORTED`,
// and its test (web/test/board-export.test.ts) keeps that list whole; the parity test keeps this one the same. Each row
// is taken whole (`SELECT *`), so a column added to a table travels without a change here.
use crate::db::{on_postgres, sql};
use crate::error::{ApiError, Result};
use base64::Engine;
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Column, Row, ValueRef};
use std::collections::HashSet;
use std::sync::LazyLock;

const OF_PROJECT: &str = "project = ?";
const OF_COMMENTS: &str = "comment IN (SELECT id FROM comments WHERE project = ?)";
const OF_SCHEDULES: &str = "schedule IN (SELECT id FROM schedules WHERE project = ?)";

/// What's exported of each table, in the file's order: which rows, by the project's id (`EXPORTED`).
const EXPORTED: [(&str, &str); 18] = [
    ("projects", "id = ?"),
    ("project_members", OF_PROJECT),
    ("releases", OF_PROJECT),
    ("milestones", OF_PROJECT),
    ("milestone_aliases", OF_PROJECT),
    ("issues", OF_PROJECT),
    ("issue_aliases", OF_PROJECT),
    ("issue_links", OF_PROJECT),
    ("issue_events", OF_PROJECT),
    ("comments", OF_PROJECT),
    ("milestone_comments", OF_PROJECT),
    ("schedule_requests", OF_COMMENTS),
    ("docs", OF_PROJECT),
    ("doc_sections", OF_PROJECT),
    ("doc_revisions", OF_PROJECT),
    ("schedules", OF_PROJECT),
    ("schedule_runs", OF_SCHEDULES),
    ("presets", OF_PROJECT),
];

static UPLOAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/api/uploads/([0-9a-f]{24})").unwrap());

/// One column of a row as the Nuxt server's drivers give it: a number, text, null, or (an upload's `data`) bytes, kept
/// as an array here until it's put in base64. A whole REAL is written as JavaScript writes it, with no `.0`.
fn cell(row: &AnyRow, i: usize) -> Result<Value> {
    if row.try_get_raw(i)?.is_null() {
        return Ok(Value::Null);
    }
    if let Ok(n) = row.try_get::<i64, _>(i) {
        return Ok(n.into());
    }
    if let Ok(n) = row.try_get::<f64, _>(i) {
        let whole = n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0;
        return Ok(if whole { (n as i64).into() } else { json!(n) });
    }
    if let Ok(text) = row.try_get::<String, _>(i) {
        return Ok(text.into());
    }
    if let Ok(bytes) = row.try_get::<Vec<u8>, _>(i) {
        return Ok(Value::Array(bytes.into_iter().map(Value::from).collect()));
    }
    // The last kind left; one that isn't fails as the database does.
    Ok(row.try_get::<bool, _>(i)?.into())
}

/// A row whole, its columns in the table's order.
fn whole(row: &AnyRow) -> Result<Value> {
    let mut map = Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        map.insert(column.name().to_string(), cell(row, i)?);
    }
    Ok(Value::Object(map))
}

async fn rows(conn: &mut AnyConnection, query: &str, binds: &[&str]) -> Result<Vec<Value>> {
    let text = sql(query);
    let mut q = sqlx::query(&text);
    for bind in binds {
        q = q.bind(*bind);
    }
    q.fetch_all(&mut *conn).await?.iter().map(whole).collect()
}

/// The board `project` as one file's contents (`exportBoard`): 404 when there's no such project.
pub async fn export(conn: &mut AnyConnection, project: &str) -> Result<Value> {
    let found = sqlx::query(&sql("SELECT id FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *conn).await?;
    if found.is_none() {
        return Err(ApiError::not_found(format!("No project \"{project}\"")));
    }
    sqlx::query(if on_postgres() { "BEGIN ISOLATION LEVEL REPEATABLE READ" } else { "BEGIN" }).execute(&mut *conn).await?;
    let read = read(conn, project).await;
    sqlx::query(if read.is_ok() { "COMMIT" } else { "ROLLBACK" }).execute(&mut *conn).await?;
    read
}

async fn read(conn: &mut AnyConnection, project: &str) -> Result<Value> {
    let mut tables = Map::new();
    for (table, which) in EXPORTED {
        tables.insert(table.to_string(), Value::Array(rows(conn, &format!("SELECT * FROM {table} WHERE {which}"), &[project]).await?));
    }
    let of = |table: &str| tables[table].as_array().cloned().unwrap_or_default();
    let (members, issues) = (of("project_members"), of("issues"));
    // Those the board names: its members, and its issues' assignees, claims and makers.
    let named: HashSet<String> = members
        .iter()
        .map(|row| &row["person"])
        .chain(issues.iter().flat_map(|row| [&row["assignee"], &row["claimed_by"], &row["created_person"]]))
        .filter_map(Value::as_str)
        .map(str::to_lowercase)
        .collect();
    let people: Vec<Value> = rows(conn, "SELECT id, name FROM people ORDER BY id", &[])
        .await?
        .into_iter()
        .filter(|person| person["id"].as_str().is_some_and(|id| named.contains(id)))
        .collect();
    let used: HashSet<&Value> = issues.iter().map(|row| &row["status"]).collect();
    let statuses: Vec<Value> =
        rows(conn, "SELECT * FROM statuses ORDER BY position", &[]).await?.into_iter().filter(|status| used.contains(&status["id"])).collect();
    // The images its text shows.
    let text = serde_json::to_string(&tables).unwrap_or_default();
    let mut shown: Vec<&str> = Vec::new();
    for found in UPLOAD.captures_iter(&text) {
        let id = found.get(1).map_or("", |m| m.as_str());
        if !shown.contains(&id) {
            shown.push(id)
        }
    }
    let mut uploads = if shown.is_empty() {
        Vec::new()
    } else {
        let marks = vec!["?"; shown.len()].join(", ");
        rows(conn, &format!("SELECT * FROM uploads WHERE id IN ({marks}) ORDER BY id"), &shown).await?
    };
    for upload in &mut uploads {
        if let Some(data) = upload.get_mut("data") {
            let bytes: Vec<u8> = data.as_array().map(|a| a.iter().filter_map(Value::as_u64).map(|b| b as u8).collect()).unwrap_or_default();
            *data = base64::engine::general_purpose::STANDARD.encode(bytes).into();
        }
    }
    Ok(json!({
        "format": "orrery-board",
        "format_version": 1,
        "schema_step": crate::steps::SQLITE.len(),
        "exported_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "project": project,
        "people": people,
        "statuses": statuses,
        "uploads": uploads,
        "tables": tables,
    }))
}
