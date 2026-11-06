// The Rust API's copy of the migrations (ORR-931, api/migrations and api/src/steps.rs): each step of
// server/utils/migrations as a numbered SQL file, and the steps that are code here written again in Rust (api/src/migrate.rs).
// The Node app still runs the migrations, and a new step is still written there. Then, to port it:
//
//   ORRERY_WRITE_MIGRATIONS=1 pnpm --dir web exec vitest run --project unit test/rust-migrations.test.ts
//
// which writes the files, plus a Rust arm for any new code step. The first test fails until they match. With the
// binary built (as for test/api-parity.test.ts), the rest check that `orrery-api migrate` makes the same database Node
// does: from empty, and carrying on from a step Node stopped at. That's on SQLite, and on Postgres with TEST_POSTGRES_URL.
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import {describe, expect, it} from 'vitest'
import {MIGRATIONS} from '../server/utils/migrations/sqlite'
import {BASELINE, SCHEMA, STEPS} from '../server/utils/migrations/postgres'
import {migrate} from '../server/utils/db'
import {PostgresDb} from '../server/utils/postgres'

const API = fileURLToPath(new URL('../../api/', import.meta.url))
const BIN = process.env.ORRERY_API_BIN || join(API, 'target/debug/orrery-api')
const POSTGRES = process.env.TEST_POSTGRES_URL
const pad = (n: number) => String(n).padStart(3, '0')

/** Every file the port should hold, by its path under api/, as the migrations are now. */
function expected(): Map<string, string> {
    const files = new Map<string, string>()
    const list = (dir: string, steps: unknown[], from: number) => steps.map((step, i) => {
        const n = from + i + 1
        if (typeof step !== 'string') return `    Step::Code(${n}),`
        files.set(`migrations/${dir}/${pad(n)}.sql`, step)
        return `    Step::Sql(include_str!("../migrations/${dir}/${pad(n)}.sql")),`
    }).join('\n')
    files.set(`migrations/postgres/${pad(BASELINE)}-baseline.sql`, SCHEMA)
    files.set('src/steps.rs', `// Written by web/test/rust-migrations.test.ts from web/server/utils/migrations (ORR-931): don't edit it, run that.
use crate::migrate::Step;

/// SQLite's steps, each bringing \`PRAGMA user_version\` up one.
#[rustfmt::skip]
pub const SQLITE: &[Step] = &[
${list('sqlite', MIGRATIONS, 0)}
];

/// SQLite's step Postgres's baseline matches.
pub const POSTGRES_BASELINE: u32 = ${BASELINE};

/// Postgres's schema at that step, laid down on an empty database.
pub const POSTGRES_SCHEMA: &str = include_str!("../migrations/postgres/${pad(BASELINE)}-baseline.sql");

/// Postgres's steps after the baseline, each bringing \`schema_version\` up one.
#[rustfmt::skip]
pub const POSTGRES: &[Step] = &[
${list('postgres', STEPS, BASELINE)}
];
`)
    return files
}

/** The port's files as they are on disk. */
function onDisk(): Map<string, string> {
    const files = new Map<string, string>()
    for (const dir of ['sqlite', 'postgres']) {
        const at = join(API, 'migrations', dir)
        if (!existsSync(at)) continue
        for (const name of readdirSync(at)) files.set(`migrations/${dir}/${name}`, readFileSync(join(at, name), 'utf8'))
    }
    if (existsSync(join(API, 'src/steps.rs'))) files.set('src/steps.rs', readFileSync(join(API, 'src/steps.rs'), 'utf8'))
    return files
}

describe("the Rust API's migrations", () => {
    it('are the Node app\'s, step for step', () => {
        const want = expected()
        if (process.env.ORRERY_WRITE_MIGRATIONS === '1') {
            for (const [path, text] of want) {
                mkdirSync(join(API, path, '..'), {recursive: true})
                writeFileSync(join(API, path), text)
            }
        }
        const have = onDisk()
        // A step is never edited, so one that differs or is missing is a new step not ported yet: see the top of this file.
        expect([...have.keys()].sort()).toEqual([...want.keys()].sort())
        for (const [path, text] of want) expect(have.get(path), path).toBe(text)
    })

    it('port every code step to Rust', () => {
        const rust = readFileSync(join(API, 'src/migrate.rs'), 'utf8')
        const code = (steps: unknown[], from: number) => steps.flatMap((step, i) => typeof step === 'string' ? [] : [from + i + 1])
        for (const n of code(MIGRATIONS, 0)) expect(rust, `SQLite's step ${n}`).toMatch(new RegExp(`\\(Dialect::Sqlite, ${n}\\) =>`))
        for (const n of code(STEPS, BASELINE)) expect(rust, `Postgres's step ${n}`).toMatch(new RegExp(`\\(Dialect::Postgres, ${n}\\) =>`))
    })
})

/** Runs `orrery-api migrate` on `setting`, failing with what it said if it didn't finish. */
function rustMigrate(setting: string, schema?: string, env: Record<string, string> = {}): string {
    const run = spawnSync(BIN, ['migrate'], {env: {...process.env, NUXT_DATABASE: setting, ...schema ? {ORRERY_API_SCHEMA: schema} : {}, ...env}, encoding: 'utf8'})
    if (run.status !== 0) throw new Error(`orrery-api migrate stopped (${run.status}): ${run.stderr}`)
    return run.stderr
}

/** What a SQLite file holds that a migration decides: each table's and index's SQL, the step, and the rows the steps
 * put there (the statuses, the settings without their random values). */
function sqliteState(path: string) {
    const db = new DatabaseSync(path)
    try {
        return {
            step: (db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version,
            schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
            statuses: db.prepare('SELECT * FROM statuses ORDER BY id').all(),
            settings: db.prepare("SELECT key FROM settings ORDER BY key").all(),
        }
    } finally {
        db.close()
    }
}

/** A new SQLite file, migrated by Node up to `upTo`. */
function nodeSqlite(upTo: number, then?: (db: DatabaseSync) => void): string {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-migrate-')), 'orrery.db')
    const db = new DatabaseSync(path)
    migrate(db, path, upTo)
    then?.(db)
    db.close()
    return path
}

/** The step before the owner moves to `people` (ORR-653), the latest of the code steps on both databases. */
const BEFORE_PEOPLE = MIGRATIONS.findIndex(step => typeof step === 'function' && String(step).includes('CREATE TABLE people'))

describe.skipIf(!existsSync(BIN))('orrery-api migrate on SQLite', () => {
    it('makes the database Node makes, from empty', () => {
        const ours = nodeSqlite(MIGRATIONS.length)
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-migrate-')), 'orrery.db')
        expect(rustMigrate(path)).toMatch(`from step 0 to ${MIGRATIONS.length}`)
        expect(sqliteState(path)).toEqual(sqliteState(ours))
        expect(rustMigrate(path)).toMatch(`at step ${MIGRATIONS.length} already`)
    })

    it('carries on from the step Node stopped at, owner, boards and all', () => {
        const owner = (db: DatabaseSync) => {
            db.prepare("INSERT INTO settings (key, value) VALUES ('owner', ?)").run(JSON.stringify('Åse Dybvik'))
            db.prepare("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('larder', 'Larder', 'LAR', 'agent', '2026-01-01', '2026-01-01')").run()
        }
        const ours = nodeSqlite(BEFORE_PEOPLE, owner)
        const node = nodeSqlite(BEFORE_PEOPLE, owner)
        rustMigrate(ours)
        const db = new DatabaseSync(node)
        migrate(db, node, MIGRATIONS.length)
        db.close()
        expect(sqliteState(ours)).toEqual(sqliteState(node))
        const after = new DatabaseSync(ours)
        expect(after.prepare('SELECT id, name, role FROM people').all()).toEqual([{id: 'ase_dybvik', name: 'Åse Dybvik', role: 'owner'}])
        expect((after.prepare('SELECT uid FROM projects').get() as {uid: string}).uid).toMatch(/^[a-z2-7]{8}$/)
        expect(JSON.parse((after.prepare("SELECT value FROM settings WHERE key = 'uid'").get() as {value: string}).value)).toMatch(/^[a-z2-7]{8}$/)
        after.close()
    })

    it('keeps a copy of the file as it was before it upgrades it, as Node does (ORR-448)', () => {
        const path = nodeSqlite(BEFORE_PEOPLE)
        const copy = join(dirname(path), `orrery-pre-1.2.3-step${BEFORE_PEOPLE}.db`)
        const run = spawnSync(BIN, ['migrate'], {env: {...process.env, NUXT_DATABASE: path, ORRERY_VERSION: '1.2.3'}, encoding: 'utf8'})
        expect(run.status, run.stderr).toBe(0)
        expect(readdirSync(dirname(path)).filter(name => name.startsWith('orrery-pre-'))).toEqual([`orrery-pre-1.2.3-step${BEFORE_PEOPLE}.db`])
        const kept = new DatabaseSync(copy, {readOnly: true})
        expect((kept.prepare('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(BEFORE_PEOPLE)
        kept.close()
        // Into the backup folder, when there is one; and none for a new file, which has nothing to keep.
        const backups = join(mkdtempSync(join(tmpdir(), 'orrery-backups-')), 'nested')
        rustMigrate(nodeSqlite(BEFORE_PEOPLE), undefined, {ORRERY_API_BACKUP_DIR: backups})
        expect(readdirSync(backups)).toEqual([`orrery-pre-upgrade-step${BEFORE_PEOPLE}.db`])
        const fresh = join(mkdtempSync(join(tmpdir(), 'orrery-migrate-')), 'orrery.db')
        rustMigrate(fresh)
        expect(readdirSync(dirname(fresh))).toEqual(['orrery.db'])
    })

    it('won\'t upgrade without that copy', () => {
        const path = nodeSqlite(BEFORE_PEOPLE)
        const nowhere = join(dirname(path), 'a-file')
        writeFileSync(nowhere, '')
        const run = spawnSync(BIN, ['migrate'], {env: {...process.env, NUXT_DATABASE: path, ORRERY_API_BACKUP_DIR: join(nowhere, 'backups')}, encoding: 'utf8'})
        expect(run.status).toBe(1)
        expect(run.stderr).toMatch(`won't upgrade ${path} (schema step ${BEFORE_PEOPLE} to ${MIGRATIONS.length}) without a copy of it as it is`)
        expect(sqliteState(path).step).toBe(BEFORE_PEOPLE)
    })

    it('stops at the owner\'s step on an owner setting that isn\'t JSON, rather than lose them', () => {
        const path = nodeSqlite(BEFORE_PEOPLE, db => db.prepare("INSERT INTO settings (key, value) VALUES ('owner', 'Åse')").run())
        const run = spawnSync(BIN, ['migrate'], {env: {...process.env, NUXT_DATABASE: path}, encoding: 'utf8'})
        expect(run.status).toBe(1)
        expect(run.stderr).toMatch(`schema step ${BEFORE_PEOPLE + 1} failed: the owner setting isn't JSON`)
        const db = new DatabaseSync(path, {readOnly: true})
        expect(db.prepare("SELECT value FROM settings WHERE key = 'owner'").get()).toEqual({value: 'Åse'})
        expect((db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(BEFORE_PEOPLE)
        db.close()
    })

    it('refuses a database from a newer orrery', () => {
        const path = nodeSqlite(MIGRATIONS.length, db => db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`))
        const run = spawnSync(BIN, ['migrate'], {env: {...process.env, NUXT_DATABASE: path}, encoding: 'utf8'})
        expect(run.status).toBe(1)
        expect(run.stderr).toMatch('written by a newer orrery')
    })
})

describe.skipIf(!existsSync(BIN) || !POSTGRES)('orrery-api migrate on Postgres', () => {
    /** What a schema holds that a migration decides, as for SQLite. */
    async function postgresState(schema: string) {
        const client = new pg.Client({connectionString: POSTGRES})
        await client.connect()
        try {
            // A constraint names the schema of what it references: each test's own, so it's left out.
            const rows = async (sql: string) => JSON.parse(JSON.stringify((await client.query(sql, [schema])).rows).replaceAll(schema, 'schema'))
            return {
                step: (await client.query(`SELECT version FROM "${schema}".schema_version`)).rows,
                columns: await rows(`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default FROM information_schema.columns
                    WHERE table_schema = $1 ORDER BY table_name, ordinal_position`),
                indexes: await rows('SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname'),
                constraints: await rows(`SELECT t.relname AS table, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
                    JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace WHERE ns.nspname = $1 ORDER BY t.relname, c.conname`),
                statuses: (await client.query(`SELECT * FROM "${schema}".statuses ORDER BY id`)).rows,
                settings: (await client.query(`SELECT key FROM "${schema}".settings ORDER BY key`)).rows,
            }
        } finally {
            await client.end()
        }
    }

    /** A new schema, migrated by Node up to `upTo`. */
    async function nodePostgres(upTo: number, then?: (db: PostgresDb) => Promise<void>): Promise<string> {
        const schema = `test_migrate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        const db = new PostgresDb(POSTGRES!, schema, upTo)
        await db.get('SELECT 1')
        await then?.(db)
        await db.close()
        return schema
    }

    /** An empty schema of its own, for the Rust API to lay down. */
    async function emptySchema(): Promise<string> {
        const schema = `test_migrate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        const client = new pg.Client({connectionString: POSTGRES})
        await client.connect()
        await client.query(`CREATE SCHEMA "${schema}"`)
        await client.end()
        return schema
    }

    it('makes the database Node makes, from empty', async () => {
        const ours = await emptySchema()
        expect(rustMigrate(POSTGRES!, ours)).toMatch(`from step 0 to ${BASELINE + STEPS.length}`)
        const node = await nodePostgres(BASELINE + STEPS.length)
        const [a, b] = [await postgresState(ours), await postgresState(node)]
        expect(a).toEqual(b)
        expect(rustMigrate(POSTGRES!, ours)).toMatch(`at step ${BASELINE + STEPS.length} already`)
    }, 30_000)

    it('carries on from the step Node stopped at, owner and all', async () => {
        const owner = async (db: PostgresDb) => {
            await db.run("INSERT INTO settings (key, value) VALUES ('owner', ?)", JSON.stringify('Åse Dybvik'))
        }
        const ours = await nodePostgres(BEFORE_PEOPLE, owner)
        rustMigrate(POSTGRES!, ours)
        const node = await nodePostgres(BEFORE_PEOPLE, owner)
        const db = new PostgresDb(POSTGRES!, node)
        await db.get('SELECT 1')
        await db.close()
        expect(await postgresState(ours)).toEqual(await postgresState(node))
        const client = new pg.Client({connectionString: POSTGRES})
        await client.connect()
        expect((await client.query(`SELECT id, name, role FROM "${ours}".people`)).rows).toEqual([{id: 'ase_dybvik', name: 'Åse Dybvik', role: 'owner'}])
        await client.end()
    }, 30_000)
})
