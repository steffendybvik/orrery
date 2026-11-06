// The orrery's projects, listing them (ORR-997): what `listProjects` does (web/server/store/projects.ts), answering as
// `GET /api/projects` does without `?expand=board`. Each project is its row as `projectOf` hands it out (base.ts), with
// its docs, doc sections and releases, and in place of its board the board's counts and kinds and how many milestones
// it has. The board itself (`?expand=board`, `GET /api/projects/:project`) stays on the Nuxt server, as its `rev` is the
// events stream's; making, changing and deleting projects stay there too.
use crate::db::sql;
use crate::docs::Docs;
use crate::error::Result;
use crate::issues::{kinds_json, sum, Issues};
use crate::plans::Plans;
use serde_json::{json, Map, Value};
use sqlx::{AnyConnection, Row};

const PROJECT_COLUMNS: &str = "id, name, key, uid, description, icon, icon_color, focus_prompt, milestone_prompt, instructions, muted, repo, \
    release_mode, releases_from, created_by, CAST(owned AS BIGINT) AS owned, created_at, updated_at";

/// A JSON column as it was kept, or `fallback` when it doesn't parse.
fn parsed(text: Option<String>, fallback: Value) -> Value {
    text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(fallback)
}

pub struct Projects<'c> {
    conn: &'c mut AnyConnection,
}

impl<'c> Projects<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Projects { conn }
    }

    /// Whether orrery may start sessions, and within what: the orrery's setting, as every project shares it (`orreryStarts`).
    async fn starts(&mut self) -> Result<Option<Value>> {
        let row = sqlx::query(&sql("SELECT value FROM settings WHERE key = ?")).bind("starts").fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|r| parsed(r.get("value"), Value::Null)).filter(|v| !v.is_null()))
    }

    /// Every project, by name, each with its counts (`listProjects`).
    pub async fn list(&mut self) -> Result<Value> {
        let rows = sqlx::query(&sql(&format!("SELECT {PROJECT_COLUMNS} FROM projects ORDER BY lower(name), name"))).fetch_all(&mut *self.conn).await?;
        let starts = self.starts().await?;
        let mut out = Vec::new();
        for row in &rows {
            let id: String = row.get("id");
            let mut project = Map::new();
            project.insert("id".into(), json!(id));
            for column in ["name", "key", "uid", "created_by", "created_at", "updated_at", "release_mode"] {
                project.insert(column.into(), json!(row.get::<Option<String>, _>(column).unwrap_or_default()));
            }
            // What the store leaves undefined, and so out of its reply, is left out here too.
            for column in ["description", "icon", "icon_color", "focus_prompt", "milestone_prompt", "repo", "releases_from"] {
                if let Some(value) = row.get::<Option<String>, _>(column) {
                    project.insert(column.into(), json!(value));
                }
            }
            project.insert("instructions".into(), parsed(row.get("instructions"), json!([])));
            project.insert("muted".into(), parsed(row.get("muted"), json!([])));
            if let Some(starts) = &starts {
                project.insert("starts".into(), starts.clone());
            }
            project.insert("protected".into(), json!(row.get::<i64, _>("owned") != 0));
            let mut docs = Docs::new(&mut *self.conn);
            project.insert("docs".into(), docs.list(&id, None).await?);
            project.insert("doc_sections".into(), docs.sections(&id).await?);
            let mut issues = Issues::new(&mut *self.conn);
            let statuses = issues.statuses().await?;
            let (board, releases) = Plans::new(&mut issues).board_and_releases(&id, &statuses).await?;
            project.insert("releases".into(), Value::Array(releases.into_iter().map(Value::Object).collect()));
            let (mut counts, mut kinds) = (Map::new(), [0; 6]);
            for group in &board.milestones {
                for task in &group.tasks {
                    sum(&mut counts, &mut kinds, task);
                }
            }
            project.insert("counts".into(), Value::Object(counts));
            project.insert("kinds".into(), kinds_json(&kinds));
            project.insert("milestones".into(), json!(board.milestones.iter().filter(|g| !g.id.is_empty()).count()));
            out.push(Value::Object(project));
        }
        Ok(Value::Array(out))
    }
}
