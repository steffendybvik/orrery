// The schema's migrations (ORR-931): `orrery-api migrate` brings a database to the latest step. The Nuxt server runs it
// before it opens a database whenever it has this binary, and only falls back to its own copy of the steps without one
// (tests, a bare `nuxt dev`) or with a build whose steps end elsewhere. A new step is a SQL file in api/migrations;
// web/test/rust-migrations.test.ts lists them in steps.rs, and in the Nuxt server's from-api.ts. Its own steps, ported
// from there, are frozen, and the code steps among them have their arms here.
//
// The steps are the same ones, counted the same way: SQLite's in `PRAGMA user_version`, Postgres's in `schema_version`
// from its baseline. So a database either one migrated carries on with the other, with no reset.
use crate::steps::{POSTGRES, POSTGRES_BASELINE, POSTGRES_SCHEMA, SQLITE};
use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use sqlx::any::install_default_drivers;
use sqlx::{AnyConnection, Connection, Row};
use unicode_normalization::UnicodeNormalization;

/// A step: SQL, or one that's code (numbered as it brings the schema to that step), for what SQL can't say.
pub enum Step {
    Sql(&'static str),
    Code(u32),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dialect {
    Sqlite,
    Postgres,
}

/// What a run did: the step it found the database at, and the one it left it at.
pub struct Migrated {
    pub from: u32,
    pub to: u32,
}

/// The step a database is at once this build has migrated it.
pub fn latest(dialect: Dialect) -> u32 {
    match dialect {
        Dialect::Sqlite => SQLITE.len() as u32,
        Dialect::Postgres => POSTGRES_BASELINE + POSTGRES.len() as u32,
    }
}

/// Brings `setting`'s database (a SQLite file's path, made if it isn't there, or a `postgres://` URL) up to the latest
/// step. `schema`, on Postgres, is the one to work in, made if it isn't there, as the Node app does.
pub async fn migrate(setting: &str, schema: Option<&str>) -> Result<Migrated, String> {
    install_default_drivers();
    if crate::db::is_postgres(setting) {
        let mut conn = AnyConnection::connect(setting).await.map_err(|e| format!("can't open the database: {e}"))?;
        postgres(&mut conn, schema).await
    } else {
        let mut conn = AnyConnection::connect(&format!("sqlite://{setting}?mode=rwc")).await.map_err(|e| format!("can't open {setting}: {e}"))?;
        sqlite(&mut conn, setting).await
    }
}

fn failed(step: u32) -> impl Fn(sqlx::Error) -> String {
    move |e| format!("schema step {step} failed: {e}")
}

async fn exec(conn: &mut AnyConnection, sql: &str) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(sql).execute(conn).await.map(|_| ())
}

async fn sqlite(conn: &mut AnyConnection, path: &str) -> Result<Migrated, String> {
    let latest = latest(Dialect::Sqlite);
    let version: i64 = sqlx::query("PRAGMA user_version").fetch_one(&mut *conn).await.and_then(|r| r.try_get(0)).map_err(|e| e.to_string())?;
    let version = version as u32;
    if version > latest {
        return Err(format!(
            "{path} was written by a newer orrery (schema step {version}; this one knows up to {latest}). Run that version again, or restore the copy taken before it upgraded (orrery-pre-<version>-step<n>.db, in the backup folder or beside the database)."
        ));
    }
    if version > 0 && version < latest {
        keep_a_copy(conn, path, version, latest).await?;
    }
    // Foreign keys are off while tables are rebuilt (SQLite can't turn them off inside a transaction).
    exec(conn, "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF").await.map_err(|e| e.to_string())?;
    for (i, step) in SQLITE.iter().enumerate().skip(version as usize) {
        let n = i as u32 + 1;
        exec(conn, "BEGIN IMMEDIATE").await.map_err(failed(n))?;
        let done = async {
            match step {
                Step::Sql(sql) => exec(conn, sql).await.map_err(failed(n))?,
                Step::Code(n) => code(conn, Dialect::Sqlite, *n).await?,
            }
            exec(conn, &format!("PRAGMA user_version = {n}")).await.map_err(failed(n))
        }
        .await;
        if let Err(e) = done {
            exec(conn, "ROLLBACK").await.ok();
            return Err(e);
        }
        exec(conn, "COMMIT").await.map_err(failed(n))?;
    }
    if !sqlx::query("PRAGMA foreign_key_check").fetch_all(&mut *conn).await.map_err(|e| e.to_string())?.is_empty() {
        return Err(format!("{path}: a migration left rows pointing at nothing"));
    }
    exec(conn, "PRAGMA foreign_keys = ON").await.map_err(|e| e.to_string())?;
    Ok(Migrated { from: version, to: latest })
}

/// Where the copy of a SQLite file goes before an upgrade, as `beforeUpgrade` in web/server/utils/db.ts puts it: in the
/// backup folder (`ORRERY_API_BACKUP_DIR`, the Nuxt server's backup setting), or beside the file, named by the version
/// (`ORRERY_VERSION`) and the step it was at, so a later step under the same version gets one of its own (ORR-457).
fn copy_path(path: &str, version: u32) -> std::path::PathBuf {
    copy_path_with(path, version, std::env::var("ORRERY_API_BACKUP_DIR").ok(), std::env::var("ORRERY_VERSION").ok())
}

/// `copy_path`, with the backup folder and the version as the environment gave them.
fn copy_path_with(path: &str, version: u32, backups: Option<String>, release: Option<String>) -> std::path::PathBuf {
    let dir = backups
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::Path::new(path).parent().map(|p| p.to_path_buf()).unwrap_or_default());
    let release = release.filter(|v| !v.is_empty()).unwrap_or_else(|| "upgrade".into());
    dir.join(format!("orrery-pre-{release}-step{version}.db"))
}

/// Copies the file as it is before its steps run, as the Node app's `migrate` does (ORR-448): written beside the name and
/// checked before it takes it, so a copy cut short never passes for one, and one already there (an earlier try at this
/// same upgrade) stays. Without a copy, it doesn't upgrade.
async fn keep_a_copy(conn: &mut AnyConnection, path: &str, version: u32, latest: u32) -> Result<(), String> {
    let copy = copy_path(path, version);
    if copy.exists() {
        return Ok(());
    }
    let partial = std::path::PathBuf::from(format!("{}.partial", copy.display()));
    let made = async {
        if let Some(dir) = copy.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        if partial.exists() {
            std::fs::remove_file(&partial).map_err(|e| e.to_string())?;
        }
        sqlx::query("VACUUM INTO ?").bind(partial.to_string_lossy().into_owned()).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        let mut check = AnyConnection::connect(&format!("sqlite://{}?mode=ro", partial.display())).await.map_err(|e| e.to_string())?;
        let found: Vec<String> = sqlx::query("PRAGMA quick_check")
            .fetch_all(&mut check)
            .await
            .map_err(|e| e.to_string())?
            .iter()
            .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
            .collect();
        check.close().await.ok();
        if found != ["ok"] {
            return Err(format!("the copy isn't sound ({})", found.join("; ")));
        }
        std::fs::rename(&partial, &copy).map_err(|e| e.to_string())
    }
    .await;
    made.map_err(|e| {
        std::fs::remove_file(&partial).ok();
        format!(
            "orrery won't upgrade {path} (schema step {version} to {latest}) without a copy of it as it is, and couldn't make one at {}: {e}. Free some space or fix the folder, then start it again.",
            copy.display()
        )
    })
}

async fn postgres(conn: &mut AnyConnection, schema: Option<&str>) -> Result<Migrated, String> {
    let latest = latest(Dialect::Postgres);
    if let Some(schema) = schema {
        let schema = schema.replace('"', "");
        exec(conn, &format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\"; SET search_path TO \"{schema}\"")).await.map_err(|e| e.to_string())?;
    }
    exec(conn, "BEGIN").await.map_err(|e| e.to_string())?;
    let done = async {
        // Two servers starting at once wait for each other here, the Node app's included: it takes the same lock.
        exec(conn, "SELECT pg_advisory_xact_lock(4207); CREATE TABLE IF NOT EXISTS schema_version (version integer NOT NULL)").await.map_err(|e| e.to_string())?;
        let row = sqlx::query("SELECT CAST(version AS bigint) FROM schema_version").fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?;
        let found = match row {
            Some(row) => Some(row.try_get::<i64, _>(0).map_err(|e| e.to_string())? as u32),
            None => None,
        };
        let mut version = found.unwrap_or(0);
        if version > latest {
            return Err(format!(
                "This Postgres database was written by a newer orrery (schema step {version}; this one knows up to {latest}). Run that version again, or restore a backup from before it upgraded."
            ));
        }
        if found.is_none() {
            exec(conn, POSTGRES_SCHEMA).await.map_err(failed(POSTGRES_BASELINE))?;
            exec(conn, &format!("INSERT INTO schema_version (version) VALUES ({POSTGRES_BASELINE})")).await.map_err(failed(POSTGRES_BASELINE))?;
            version = POSTGRES_BASELINE;
        }
        for (i, step) in POSTGRES.iter().enumerate() {
            let n = POSTGRES_BASELINE + i as u32 + 1;
            if version >= n {
                continue;
            }
            match step {
                Step::Sql(sql) => exec(conn, sql).await.map_err(failed(n))?,
                Step::Code(n) => code(conn, Dialect::Postgres, *n).await?,
            }
            exec(conn, &format!("UPDATE schema_version SET version = {n}")).await.map_err(failed(n))?;
            version = n;
        }
        Ok(found.unwrap_or(0))
    }
    .await;
    match done {
        Ok(from) => {
            exec(conn, "COMMIT").await.map_err(|e| e.to_string())?;
            Ok(Migrated { from, to: latest })
        }
        Err(e) => {
            exec(conn, "ROLLBACK").await.ok();
            Err(e)
        }
    }
}

/// The steps that are code in the Node app, written again here.
async fn code(conn: &mut AnyConnection, dialect: Dialect, n: u32) -> Result<(), String> {
    let fail = failed(n);
    match (dialect, n) {
        // Renumbered each board's issues by their order (renumberSync), back when ids were first counted per board.
        // Only a database from before then has any to renumber, and that's the Node app's to bring forward.
        (Dialect::Sqlite, 4) => {
            let boards: i64 = sqlx::query("SELECT count(*) FROM projects").fetch_one(&mut *conn).await.and_then(|r| r.try_get(0)).map_err(&fail)?;
            if boards > 0 {
                return Err(
                    "this database is from before schema step 4, which renumbers its boards' issues: open it with the Node app first, which brings it forward"
                        .into(),
                );
            }
            Ok(())
        }
        // The owner moves from `settings` to `people` (ORR-653).
        (Dialect::Sqlite, 63) => people(conn, SQLITE_PEOPLE, "INSERT INTO people (id, name, role, created_at) VALUES (?, ?, 'owner', ?)", n).await,
        (Dialect::Postgres, 63) => people(conn, POSTGRES_PEOPLE, "INSERT INTO people (id, name, role, created_at) VALUES ($1, $2, 'owner', $3)", n).await,
        // Each board and the server get a random id, for the full form of ids (ORR-674). Postgres's is SQL.
        (Dialect::Sqlite, 64) => {
            exec(conn, "ALTER TABLE projects ADD COLUMN uid TEXT NOT NULL DEFAULT ''").await.map_err(&fail)?;
            let boards: Vec<String> = sqlx::query("SELECT id FROM projects")
                .fetch_all(&mut *conn)
                .await
                .map_err(&fail)?
                .iter()
                .map(|r| r.try_get(0))
                .collect::<Result<_, _>>()
                .map_err(&fail)?;
            for id in boards {
                let uid = random_uid(conn).await.map_err(&fail)?;
                sqlx::query("UPDATE projects SET uid = ? WHERE id = ?").bind(uid).bind(id).execute(&mut *conn).await.map_err(&fail)?;
            }
            let uid = random_uid(conn).await.map_err(&fail)?;
            sqlx::query("INSERT INTO settings (key, value) VALUES ('uid', ?)").bind(Value::String(uid).to_string()).execute(&mut *conn).await.map_err(&fail)?;
            Ok(())
        }
        _ => Err(format!("schema step {n} is code in the Node app that hasn't been written here yet (api/src/migrate.rs)")),
    }
}

// Each as the Node app's step writes it, so the table's SQL as SQLite keeps it is the same.
const SQLITE_PEOPLE: &str = r#"
    -- The people on this orrery (ORR-653): the owner, moved over from settings, and the members they add. A person's id
    -- never changes once they're a member; the owner's follows their name, as it always has.
    CREATE TABLE people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        handle TEXT,
        created_at TEXT NOT NULL,
        removed_at TEXT
    );
    CREATE UNIQUE INDEX people_one_owner ON people(role) WHERE role = 'owner';
"#;

const POSTGRES_PEOPLE: &str = r#"
    -- The people on this orrery (ORR-653): the owner, moved over from settings, and the members they add. A person's id
    -- never changes once they're a member; the owner's follows their name, as it always has.
    CREATE TABLE people (
        id text PRIMARY KEY,
        name text NOT NULL,
        role text NOT NULL CHECK (role IN ('owner', 'member')),
        handle text,
        created_at text NOT NULL,
        removed_at text
    );
    CREATE UNIQUE INDEX people_one_owner ON people(role) WHERE role = 'owner';
"#;

async fn people(conn: &mut AnyConnection, table: &str, insert: &str, n: u32) -> Result<(), String> {
    let fail = failed(n);
    exec(conn, table).await.map_err(&fail)?;
    let owner: Option<String> = sqlx::query("SELECT value FROM settings WHERE key = 'owner'")
        .fetch_optional(&mut *conn)
        .await
        .map_err(&fail)?
        .map(|r| r.try_get(0))
        .transpose()
        .map_err(&fail)?;
    // A setting that isn't JSON stops the step, so the owner isn't dropped unnoticed, as the Node app's throws.
    let person = owner.as_deref().map(owner_person).transpose().map_err(|e| format!("schema step {n} failed: the owner setting {e}"))?.flatten();
    if let Some((id, name)) = person {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query(insert).bind(id).bind(name).bind(now).execute(&mut *conn).await.map_err(&fail)?;
    }
    exec(conn, "DELETE FROM settings WHERE key = 'owner'").await.map_err(fail)
}

/// What JavaScript's `String(value)` makes of a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Array(items) => items.iter().map(|v| if v.is_null() { String::new() } else { js_string(v) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

/// The owner as they move to `people`, from their `settings` value (their name, as JSON): none for a name with nothing
/// in it to make an id from, and an error for a value that isn't JSON. As web/server/utils/owner-person.ts.
fn owner_person(value: &str) -> Result<Option<(String, String)>, String> {
    let name = js_string(&serde_json::from_str::<Value>(value).map_err(|e| format!("isn't JSON: {e}"))?);
    let id = actor_id(&name);
    Ok((!id.is_empty()).then_some((id, name)))
}

/// A name as an actor's id, as `actorId` in web/server/store/schema.ts: accents off, lowercase, `_` between the rest.
pub fn actor_id(name: &str) -> String {
    let plain: String = name.nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase();
    let mut id = String::with_capacity(plain.len());
    for c in plain.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            id.push(c)
        } else if !id.ends_with('_') {
            id.push('_')
        }
    }
    id.trim_matches('_').to_string()
}

/// A board's or a server's random id (ORR-674), as `randomUid` in web/server/utils/uid.ts: 40 random bits, SQLite's own,
/// as 8 characters of base32.
async fn random_uid(conn: &mut AnyConnection) -> Result<String, sqlx::Error> {
    let hex: String = sqlx::query("SELECT hex(randomblob(5))").fetch_one(&mut *conn).await?.try_get(0)?;
    Ok(uid_of(&hex))
}

pub(crate) fn uid_of(hex: &str) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let bits = u64::from_str_radix(hex, 16).unwrap_or(0);
    (0..8).map(|i| ALPHABET[(bits >> (5 * i) & 31) as usize] as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_ids_as_the_node_app_makes_them() {
        assert_eq!(actor_id("Steffen Dybvik"), "steffen_dybvik");
        assert_eq!(actor_id("  Åse  Ødegård! "), "ase_degard");
        assert_eq!(actor_id("Ziggy"), "ziggy");
        assert_eq!(actor_id("!!!"), "");
        assert_eq!(owner_person("\"Ziggy\""), Ok(Some(("ziggy".into(), "Ziggy".into()))));
        assert_eq!(owner_person("\"…\""), Ok(None));
        // As `String(JSON.parse(value))`: not JSON fails the step, and what isn't a string is named as JavaScript names it.
        assert!(owner_person("Ziggy").is_err());
        assert_eq!(owner_person("[\"Ada\",\"Lovelace\"]"), Ok(Some(("ada_lovelace".into(), "Ada,Lovelace".into()))));
        assert_eq!(owner_person("{\"a\":1}"), Ok(Some(("object_object".into(), "[object Object]".into()))));
        assert_eq!(owner_person("12"), Ok(Some(("12".into(), "12".into()))));
    }

    #[test]
    fn the_latest_step_counts_postgres_from_its_baseline() {
        assert_eq!(latest(Dialect::Sqlite), SQLITE.len() as u32);
        assert_eq!(latest(Dialect::Postgres), POSTGRES_BASELINE + POSTGRES.len() as u32);
        assert_eq!(latest(Dialect::Sqlite), latest(Dialect::Postgres), "both dialects end at the same step");
    }

    /// A SQLite file brought up to `step` and no further, as an older orrery left it.
    async fn sqlite_at(step: u32) -> (String, AnyConnection) {
        install_default_drivers();
        let dir = std::env::temp_dir().join(format!("orrery-migrate-test-{}", crate::testing::random_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orrery.db").to_string_lossy().into_owned();
        let mut conn = AnyConnection::connect(&format!("sqlite://{path}?mode=rwc")).await.unwrap();
        exec(&mut conn, "PRAGMA foreign_keys = OFF").await.unwrap();
        for (i, step) in SQLITE.iter().enumerate().take(step as usize) {
            match step {
                Step::Sql(sql) => exec(&mut conn, sql).await.unwrap(),
                Step::Code(n) => code(&mut conn, Dialect::Sqlite, *n).await.unwrap(),
            }
            exec(&mut conn, &format!("PRAGMA user_version = {}", i + 1)).await.unwrap();
        }
        (path, conn)
    }

    async fn rows(conn: &mut AnyConnection, query: &str) -> Vec<Vec<Option<String>>> {
        let rows = sqlx::query(query).fetch_all(&mut *conn).await.unwrap();
        rows.iter().map(|r| (0..r.len()).map(|i| r.try_get::<Option<String>, _>(i).unwrap()).collect()).collect()
    }

    fn some(values: &[&str]) -> Vec<Option<String>> {
        values.iter().map(|v| Some(v.to_string())).collect()
    }

    #[tokio::test]
    async fn step_89_puts_what_is_there_in_one_default_workspace_the_owner_holds() {
        let (path, mut conn) = sqlite_at(88).await;
        exec(
            &mut conn,
            "INSERT INTO people (id, name, role, created_at) VALUES ('ziggy', 'Ziggy', 'owner', '2026-01-01T00:00:00.000Z'), ('ada', 'Ada', 'member', '2026-02-01T00:00:00.000Z');
             INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES
                ('alpha', 'Alpha', 'ALP', 'ziggy', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
                ('beta', 'Beta', 'BET', 'ada', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');
             INSERT INTO settings (key, value) VALUES ('tint', '\"teal\"');",
        )
        .await
        .unwrap();
        conn.close().await.unwrap();

        let migrated = migrate(&path, None).await.unwrap();
        assert_eq!((migrated.from, migrated.to), (88, latest(Dialect::Sqlite)));
        let mut conn = AnyConnection::connect(&format!("sqlite://{path}")).await.unwrap();
        // Named Default, coloured as the orrery's tint, as old as its oldest project.
        assert_eq!(
            rows(&mut conn, "SELECT id, name, color, created_at FROM workspaces").await,
            vec![some(&["default", "Default", "teal", "2026-03-01T00:00:00.000Z"])]
        );
        // The owner holds it, and (from step 91) the members are its members.
        assert_eq!(
            rows(&mut conn, "SELECT workspace, person, role FROM workspace_members ORDER BY role DESC").await,
            vec![some(&["default", "ziggy", "owner"]), some(&["default", "ada", "member"])]
        );
        assert_eq!(rows(&mut conn, "SELECT id, workspace FROM projects ORDER BY id").await, vec![some(&["alpha", "default"]), some(&["beta", "default"])]);
        // A project made as today, naming no workspace, lands in the default one.
        exec(&mut conn, "INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('gamma', 'Gamma', 'GAM', 'ziggy', 'x', 'x')")
            .await
            .unwrap();
        assert_eq!(rows(&mut conn, "SELECT workspace FROM projects WHERE id = 'gamma'").await, vec![some(&["default"])]);
    }

    #[tokio::test]
    async fn step_90_puts_the_servers_rows_in_the_default_workspace_and_agent_keys_but_not_person_keys() {
        let (path, mut conn) = sqlite_at(89).await;
        exec(
            &mut conn,
            "INSERT INTO people (id, name, role, created_at) VALUES ('ziggy', 'Ziggy', 'owner', 'x');
             INSERT INTO keys (id, person, kind, name, hash, created_at) VALUES ('k1', 'ziggy', 'agent', 'claude', 'h1', 'x'), ('k2', 'ziggy', 'person', 'phone', 'h2', 'x');
             INSERT INTO epics (title, created_at, updated_at, created_by) VALUES ('Workspaces', 'x', 'x', 'ziggy');",
        )
        .await
        .unwrap();
        conn.close().await.unwrap();

        migrate(&path, None).await.unwrap();
        let mut conn = AnyConnection::connect(&format!("sqlite://{path}")).await.unwrap();
        assert_eq!(rows(&mut conn, "SELECT id, workspace FROM keys ORDER BY id").await, vec![some(&["k1", "default"]), vec![Some("k2".into()), None]]);
        assert_eq!(rows(&mut conn, "SELECT title, workspace FROM epics").await, vec![some(&["Workspaces", "default"])]);
        // The statuses a new orrery seeds are in it too.
        assert_eq!(rows(&mut conn, "SELECT DISTINCT workspace FROM statuses").await, vec![some(&["default"])]);
        for table in [
            "statuses",
            "presets",
            "preset_defaults",
            "secrets",
            "secret_uses",
            "epics",
            "events",
            "chats",
            "schedules_across",
            "session_people",
            "invites",
            "uploads",
            "feature_use",
        ] {
            let columns = rows(&mut conn, &format!("SELECT dflt_value FROM pragma_table_info('{table}') WHERE name = 'workspace' AND \"notnull\" = 1")).await;
            assert_eq!(columns, vec![some(&["'default'"])], "{table}'s rows are in the default workspace");
        }
    }

    #[tokio::test]
    async fn step_91_puts_everyone_here_in_the_default_workspace_but_the_removed() {
        // As on a new orrery, the owner was named after step 89, so isn't in the workspace yet; Cy was removed.
        let (path, mut conn) = sqlite_at(90).await;
        exec(
            &mut conn,
            "INSERT INTO people (id, name, role, created_at) VALUES ('ziggy', 'Ziggy', 'owner', '2026-03-01T00:00:00.000Z'),
                ('ada', 'Ada', 'member', '2026-02-01T00:00:00.000Z'), ('bo', 'Bo', 'member', '2026-04-01T00:00:00.000Z');
             INSERT INTO people (id, name, role, created_at, removed_at) VALUES ('cy', 'Cy', 'member', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');",
        )
        .await
        .unwrap();
        conn.close().await.unwrap();

        let migrated = migrate(&path, None).await.unwrap();
        assert_eq!(migrated.from, 90);
        let mut conn = AnyConnection::connect(&format!("sqlite://{path}")).await.unwrap();
        assert_eq!(
            rows(&mut conn, "SELECT person, role, created_at FROM workspace_members WHERE workspace = 'default' ORDER BY person").await,
            vec![
                some(&["ada", "member", "2026-02-01T00:00:00.000Z"]),
                some(&["bo", "member", "2026-04-01T00:00:00.000Z"]),
                some(&["ziggy", "owner", "2026-03-01T00:00:00.000Z"]),
            ],
            "the owner owns it, the members are its members, and someone removed isn't one"
        );
    }

    #[tokio::test]
    async fn a_new_orrery_has_the_default_workspace_with_nobody_in_it_yet() {
        let (path, conn) = sqlite_at(0).await;
        conn.close().await.unwrap();
        migrate(&path, None).await.unwrap();
        let mut conn = AnyConnection::connect(&format!("sqlite://{path}")).await.unwrap();
        exec(&mut conn, "PRAGMA foreign_keys = ON").await.unwrap();
        let workspaces = rows(&mut conn, "SELECT id, name, color FROM workspaces").await;
        assert_eq!(workspaces, vec![vec![Some("default".into()), Some("Default".into()), None]], "no tint, no colour");
        assert!(rows(&mut conn, "SELECT person FROM workspace_members").await.is_empty());
        // Projects reach it by their key; one naming a workspace that isn't there is refused.
        exec(&mut conn, "INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('alpha', 'Alpha', 'ALP', 'x', 'x', 'x')")
            .await
            .unwrap();
        let stray = exec(
            &mut conn,
            "INSERT INTO projects (id, name, key, created_by, created_at, updated_at, workspace) VALUES ('beta', 'Beta', 'BET', 'x', 'x', 'x', 'nowhere')",
        )
        .await;
        assert!(stray.is_err(), "a project's workspace must be there");
    }

    async fn step_of(path: &str) -> i64 {
        let mut conn = AnyConnection::connect(&format!("sqlite://{path}?mode=ro")).await.unwrap();
        let step = sqlx::query("PRAGMA user_version").fetch_one(&mut conn).await.unwrap().try_get(0).unwrap();
        conn.close().await.ok();
        step
    }

    #[tokio::test]
    async fn a_database_from_a_newer_orrery_is_refused_and_left_as_it_was() {
        let (path, mut conn) = sqlite_at(latest(Dialect::Sqlite)).await;
        let newer = latest(Dialect::Sqlite) + 1;
        exec(&mut conn, &format!("PRAGMA user_version = {newer}")).await.unwrap();
        conn.close().await.unwrap();
        let before = std::fs::read(&path).unwrap();
        let Err(refused) = migrate(&path, None).await else { panic!("it should be refused") };
        assert!(refused.contains("written by a newer orrery") && refused.contains(&format!("schema step {newer}")), "{refused}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "not a byte changed");
        assert!(!copy_path(&path, newer).exists(), "and no copy taken, as nothing was upgraded");
    }

    #[tokio::test]
    async fn an_upgrade_keeps_a_sound_copy_as_it_was_first_and_one_at_the_latest_takes_none() {
        let (path, conn) = sqlite_at(88).await;
        conn.close().await.unwrap();
        migrate(&path, None).await.unwrap();
        let copy = copy_path(&path, 88);
        assert!(copy.exists(), "a copy at {}", copy.display());
        assert!(!std::path::PathBuf::from(format!("{}.partial", copy.display())).exists(), "and nothing half-written left");
        assert_eq!(step_of(&copy.to_string_lossy()).await, 88, "the copy is the database before its steps");
        assert_eq!(step_of(&path).await, latest(Dialect::Sqlite) as i64);
        // At the latest step already, nothing runs and nothing is copied.
        migrate(&path, None).await.unwrap();
        assert!(!copy_path(&path, latest(Dialect::Sqlite)).exists());
    }

    #[test]
    fn the_copy_goes_in_the_backup_folder_or_beside_the_file_named_for_the_version_and_step() {
        let path = "/data/orrery.db";
        assert_eq!(copy_path_with(path, 7, None, None), std::path::PathBuf::from("/data/orrery-pre-upgrade-step7.db"));
        assert_eq!(
            copy_path_with(path, 7, Some(String::new()), Some(String::new())),
            std::path::PathBuf::from("/data/orrery-pre-upgrade-step7.db"),
            "empty is unset"
        );
        assert_eq!(
            copy_path_with(path, 88, Some("/backups".into()), Some("1.0.0-rc.19".into())),
            std::path::PathBuf::from("/backups/orrery-pre-1.0.0-rc.19-step88.db")
        );
    }

    #[tokio::test]
    async fn rows_pointing_at_nothing_are_refused_after_the_steps() {
        let (path, mut conn) = sqlite_at(latest(Dialect::Sqlite)).await;
        exec(
            &mut conn,
            "INSERT INTO projects (id, name, key, created_by, created_at, updated_at, workspace) VALUES ('beta', 'Beta', 'BET', 'x', 'x', 'x', 'nowhere')",
        )
        .await
        .unwrap();
        conn.close().await.unwrap();
        let Err(refused) = migrate(&path, None).await else { panic!("it should be refused") };
        assert!(refused.ends_with("a migration left rows pointing at nothing"), "{refused}");
    }

    #[test]
    fn uids_are_eight_base32_characters() {
        assert_eq!(uid_of("0000000000"), "aaaaaaaa");
        assert_eq!(uid_of("FFFFFFFFFF"), "77777777");
        assert_eq!(uid_of("0000000001"), "baaaaaaa");
    }
}
