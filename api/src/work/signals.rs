// A project's signals, read (ORR-1087): what `listSignals` in web/server/store/signals.ts does, on the same `signals`
// rows, each as `signalOf` (web/server/store/schema.ts) gives it, answering as `GET …/signals` does. Writing them, a
// signal's delivery, the stream and the listeners stay the Nuxt server's, as they set what each session is doing.
use crate::board::issues::Issues;
use crate::db::sql;
use crate::error::Result;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};

/// How many a read gives at most, as the route asks `listSignals` for.
pub(crate) const LIMIT: i64 = 50;

const COLUMNS: &str = "CAST(id AS BIGINT) AS id, project, issue, milestone, status, release, CAST(epic AS BIGINT) AS epic, \
    CAST(schedule AS BIGINT) AS schedule, kind, note, preset, via, target, delivered_to, instructions, person, model, created_by, \
    CAST(owned AS BIGINT) AS owned, created_at";

/// Which signals: those after an id, oldest first, or the latest about an issue or a milestone.
pub(crate) enum Which<'a> {
    After(f64),
    Issue(&'a str),
    Milestone(&'a str),
}

pub(crate) struct Signals<'c> {
    conn: &'c mut AnyConnection,
}

impl<'c> Signals<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Signals { conn }
    }

    /// The project's signals, as `listSignals` gives them: a 404 for a project there isn't; an issue or milestone found
    /// by its id, an old one or its full form, and one there isn't simply has none.
    pub(crate) async fn list(&mut self, project: &str, which: Which<'_>, limit: i64) -> Result<Value> {
        let mut issues = Issues::new(self.conn);
        issues.project(project).await?;
        let rows: Vec<AnyRow> = match which {
            Which::After(after) => {
                sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM signals WHERE project = ? AND id > ? ORDER BY id LIMIT ?")))
                    .bind(project)
                    .bind(after)
                    .bind(limit)
                    .fetch_all(&mut *self.conn)
                    .await?
            }
            Which::Issue(sent) | Which::Milestone(sent) => {
                let milestone = matches!(which, Which::Milestone(_));
                let id = Issues::new(self.conn).resolve(project, sent, milestone).await?;
                let column = if milestone { "milestone" } else { "issue" };
                let mut rows = sqlx::query(&sql(&format!("SELECT {COLUMNS} FROM signals WHERE project = ? AND {column} = ? ORDER BY id DESC LIMIT ?")))
                    .bind(project)
                    .bind(id)
                    .bind(limit)
                    .fetch_all(&mut *self.conn)
                    .await?;
                rows.reverse();
                rows
            }
        };
        Ok(Value::Array(rows.iter().map(signal_of).collect()))
    }
}

/// A signal as `signalOf` gives it: what's unset left out, the lists parsed, `owned` as `protected`.
fn signal_of(row: &AnyRow) -> Value {
    let mut out = Map::new();
    let text = |name: &str| row.get::<Option<String>, _>(name);
    let put = |out: &mut Map<String, Value>, name: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(name.to_string(), value);
        }
    };
    let list = |name: &str| serde_json::from_str::<Value>(&text(name).unwrap_or_default()).unwrap_or_else(|_| json!([]));
    put(&mut out, "id", Some(json!(row.get::<i64, _>("id"))));
    put(&mut out, "project", Some(json!(row.get::<String, _>("project"))));
    for name in ["issue", "milestone", "status", "release"] {
        put(&mut out, name, text(name).map(Value::from));
    }
    put(&mut out, "epic", row.get::<Option<i64>, _>("epic").map(Value::from));
    put(&mut out, "schedule", row.get::<Option<i64>, _>("schedule").map(Value::from));
    put(&mut out, "kind", Some(json!(row.get::<String, _>("kind"))));
    put(&mut out, "note", text("note").map(Value::from));
    put(&mut out, "preset", text("preset").map(Value::from));
    put(&mut out, "via", text("via").filter(|v| v == "chat").map(Value::from));
    put(&mut out, "target", text("target").map(Value::from));
    put(&mut out, "delivered_to", Some(list("delivered_to")));
    put(&mut out, "instructions", Some(list("instructions")));
    put(&mut out, "person", text("person").filter(|p| !p.is_empty()).map(Value::from));
    put(&mut out, "model", text("model").filter(|m| !m.is_empty()).map(Value::from));
    put(&mut out, "created_by", Some(json!(row.get::<String, _>("created_by"))));
    put(&mut out, "protected", Some(json!(row.get::<Option<i64>, _>("owned").unwrap_or(0) != 0)));
    put(&mut out, "created_at", Some(json!(row.get::<String, _>("created_at"))));
    Value::Object(out)
}
