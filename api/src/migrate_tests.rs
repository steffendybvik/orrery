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
    exec(&mut conn, "INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('alpha', 'Alpha', 'ALP', 'x', 'x', 'x')").await.unwrap();
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

#[tokio::test]
async fn a_step_that_fails_is_rolled_back_and_named_and_the_ones_before_it_stay() {
    let (path, mut conn) = sqlite_at(0).await;
    let steps = [Step::Sql("CREATE TABLE kept (x)"), Step::Sql("CREATE TABLE lost (y); INSERT INTO nowhere VALUES (1)")];
    let Err(refused) = sqlite_steps(&mut conn, &path, &steps).await else { panic!("it should fail") };
    assert!(refused.starts_with("schema step 2 failed: ") && refused.contains("nowhere"), "{refused}");
    conn.close().await.unwrap();
    assert_eq!(step_of(&path).await, 1, "step 1 stays done");
    let mut conn = AnyConnection::connect(&format!("sqlite://{path}")).await.unwrap();
    assert_eq!(rows(&mut conn, "SELECT name FROM sqlite_master WHERE type = 'table'").await, vec![some(&["kept"])], "and step 2 left nothing");
}

#[tokio::test]
async fn a_code_step_that_refuses_or_is_not_written_here_fails_its_step() {
    // Step 4 on a database that has boards to renumber is the Node app's to bring forward.
    let (path, mut conn) = sqlite_at(0).await;
    let steps = [Step::Sql("CREATE TABLE projects (id TEXT); INSERT INTO projects VALUES ('alpha')"), Step::Code(4)];
    let Err(refused) = sqlite_steps(&mut conn, &path, &steps).await else { panic!("it should fail") };
    assert!(refused.contains("open it with the Node app first"), "{refused}");
    let version: i64 = sqlx::query("PRAGMA user_version").fetch_one(&mut conn).await.unwrap().try_get(0).unwrap();
    assert_eq!(version, 1, "step 1 stays done");
    // With no boards, step 4 has nothing to do.
    exec(&mut conn, "DELETE FROM projects").await.unwrap();
    assert_eq!(sqlite_steps(&mut conn, &path, &steps).await.map(|m| (m.from, m.to)).ok(), Some((1, 2)));
    // A step that's code only in the Node app.
    let (path, mut conn) = sqlite_at(0).await;
    let Err(refused) = sqlite_steps(&mut conn, &path, &[Step::Code(999)]).await else { panic!("it should fail") };
    assert!(refused.contains("schema step 999 is code in the Node app"), "{refused}");
}

/// A Postgres connection and a schema of its own to migrate, with `TEST_POSTGRES_URL` set (ORR-1057); none without.
async fn postgres_schema() -> Option<(String, String, AnyConnection)> {
    let url = std::env::var("TEST_POSTGRES_URL").ok().filter(|u| !u.is_empty())?;
    install_default_drivers();
    let schema = format!("migrate_test_{}", crate::testing::random_id());
    let conn = AnyConnection::connect(&url).await.unwrap();
    Some((url, schema, conn))
}

async fn tables_in(conn: &mut AnyConnection, schema: &str) -> i64 {
    sqlx::query("SELECT count(*) FROM information_schema.tables WHERE table_schema = $1")
        .bind(schema.to_string())
        .fetch_one(&mut *conn)
        .await
        .unwrap()
        .try_get(0)
        .unwrap()
}

#[tokio::test]
async fn on_postgres_a_step_that_fails_rolls_back_the_whole_run_and_is_named() {
    let Some((_, schema, mut conn)) = postgres_schema().await else { return };
    let steps = [Step::Sql("CREATE TABLE kept (x integer)"), Step::Sql("CREATE TABLE lost (y integer); INSERT INTO nowhere VALUES (1)")];
    let Err(refused) = postgres_steps(&mut conn, Some(&schema), &steps).await else { panic!("it should fail") };
    let failed = POSTGRES_BASELINE + 2;
    assert!(refused.starts_with(&format!("schema step {failed} failed: ")) && refused.contains("nowhere"), "{refused}");
    // One transaction: the baseline and the step before go with it, so the next run starts from nothing again.
    assert_eq!(tables_in(&mut conn, &schema).await, 0, "nothing left in {schema}");
}

#[tokio::test]
async fn on_postgres_one_at_the_latest_runs_nothing_and_one_from_a_newer_orrery_is_refused() {
    let Some((url, schema, mut conn)) = postgres_schema().await else { return };
    let latest = latest(Dialect::Postgres);
    assert_eq!(migrate(&url, Some(&schema)).await.map(|m| (m.from, m.to)).ok(), Some((0, latest)));
    assert_eq!(migrate(&url, Some(&schema)).await.map(|m| (m.from, m.to)).ok(), Some((latest, latest)), "nothing left to run");
    exec(&mut conn, &format!("UPDATE \"{schema}\".schema_version SET version = {}", latest + 1)).await.unwrap();
    let Err(refused) = migrate(&url, Some(&schema)).await else { panic!("it should be refused") };
    assert!(refused.contains("written by a newer orrery") && refused.contains(&format!("schema step {}", latest + 1)), "{refused}");
    let version: i64 =
        sqlx::query(&format!("SELECT CAST(version AS bigint) FROM \"{schema}\".schema_version")).fetch_one(&mut conn).await.unwrap().try_get(0).unwrap();
    assert_eq!(version, (latest + 1) as i64, "and left as it was");
}

#[test]
fn uids_are_eight_base32_characters() {
    assert_eq!(uid_of("0000000000"), "aaaaaaaa");
    assert_eq!(uid_of("FFFFFFFFFF"), "77777777");
    assert_eq!(uid_of("0000000001"), "baaaaaaa");
}

/// What a SQLite file's schema is: each table's columns, as `pragma_table_info` gives them, and its indexes, by name.
async fn schema_of(path: &str) -> (Vec<Vec<Option<String>>>, Vec<Vec<Option<String>>>) {
    let mut conn = AnyConnection::connect(&format!("sqlite://{path}?mode=ro")).await.unwrap();
    let columns = rows(
        &mut conn,
        "SELECT m.name, p.name, p.type, CAST(p.\"notnull\" AS TEXT), p.dflt_value, CAST(p.pk AS TEXT)
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
         WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.name",
    )
    .await;
    let indexes = rows(&mut conn, "SELECT tbl_name, name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name").await;
    conn.close().await.ok();
    (columns, indexes)
}

/// An orrery left at any step comes up to the same schema a new one gets, and this API then serves it (ORR-1168).
#[tokio::test]
async fn an_orrery_left_at_an_older_step_comes_up_to_the_schema_a_new_one_has() {
    let (fresh, conn) = sqlite_at(0).await;
    conn.close().await.unwrap();
    migrate(&fresh, None).await.unwrap();
    let new = schema_of(&fresh).await;
    assert!(new.0.len() > 100 && !new.1.is_empty(), "a schema to compare against");
    let latest = latest(Dialect::Sqlite);
    for step in [1, latest / 4, latest / 2, latest * 3 / 4, latest - 1] {
        let (path, conn) = sqlite_at(step).await;
        conn.close().await.unwrap();
        let done = migrate(&path, None).await.unwrap_or_else(|e| panic!("from step {step}: {e}"));
        assert_eq!((done.from, done.to), (step, latest), "from step {step}");
        let upgraded = schema_of(&path).await;
        assert_eq!(upgraded.0, new.0, "the columns, from step {step}");
        assert_eq!(upgraded.1, new.1, "the indexes, from step {step}");
        crate::db::open(&path, None).await.unwrap_or_else(|e| panic!("the API opens it, from step {step}: {e}"));
    }
}
