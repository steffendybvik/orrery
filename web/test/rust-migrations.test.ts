// The migrations are the Rust API's (ORR-931): api/migrations, listed in api/src/steps.rs, run by `orrery-api migrate`.
// Node's own steps (server/utils/migrations) are frozen at what they were when it handed over, and the code steps among
// them are written again in Rust (api/src/migrate.rs). A new step is a SQL file in both api/migrations/sqlite and
// api/migrations/postgres, numbered on from the last; never a code step, as this server couldn't run one. Then
//
//   ORRERY_WRITE_MIGRATIONS=1 pnpm --dir web exec vitest run --project unit test/rust-migrations.test.ts
//
// writes steps.rs, and server/utils/migrations/from-api.ts, which this server reads them through when it migrates without
// the binary (the tests, a bare `nuxt dev`). The first test fails until they match. With the binary built (as for
// test/api-parity.test.ts), the rest check that `orrery-api migrate` makes the same database Node does: from empty, and
// carrying on from a step Node stopped at. That's on SQLite, and on Postgres with TEST_POSTGRES_URL.
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import {describe, expect, it, vi} from 'vitest'
import {MIGRATIONS, SQLITE_FROZEN} from '../server/utils/migrations/sqlite'
import {BASELINE, POSTGRES_FROZEN, SCHEMA, STEPS} from '../server/utils/migrations/postgres'
import {migrate} from '../server/utils/db'
import {migrateWithApi} from '../server/utils/api-migrate'
import {PostgresDb} from '../server/utils/postgres'

const API = fileURLToPath(new URL('../../api/', import.meta.url))
const BIN = process.env.ORRERY_API_BIN || join(API, 'target/debug/orrery-api')
const POSTGRES = process.env.TEST_POSTGRES_URL
const pad = (n: number) => String(n).padStart(3, '0')

const WEB = fileURLToPath(new URL('../', import.meta.url))
const FROM_API = 'server/utils/migrations/from-api.ts'

/** How many steps Node had when it handed the migrations over: none is added there since. */
const HANDED_OVER = {sqlite: 87, postgres: 87}

/** The SQL steps in api/migrations/`dir` after `from`, in order: each `NNN.sql` from `from + 1` on, with no gaps. */
function added(dir: string, from: number): string[] {
    const at = join(API, 'migrations', dir)
    const names = readdirSync(at).filter(name => /^\d{3}\.sql$/.test(name) && Number(name.slice(0, 3)) > from).sort()
    names.forEach((name, i) => expect(name, `api/migrations/${dir}: the step after ${from + i}`).toBe(`${pad(from + i + 1)}.sql`))
    return names.map(name => readFileSync(join(at, name), 'utf8'))
}

/** Every file the migrations should be held in, by its path under api/ (and from-api.ts, by its path under web/). */
function expected(): Map<string, string> {
    const files = new Map<string, string>()
    const sqlite = added('sqlite', SQLITE_FROZEN.length)
    const postgres = added('postgres', BASELINE + POSTGRES_FROZEN.length)
    const list = (dir: string, steps: unknown[], from: number) => steps.map((step, i) => {
        const n = from + i + 1
        if (typeof step !== 'string') return `    Step::Code(${n}),`
        files.set(`migrations/${dir}/${pad(n)}.sql`, step)
        return `    Step::Sql(include_str!("../migrations/${dir}/${pad(n)}.sql")),`
    }).join('\n')
    files.set(`migrations/postgres/${pad(BASELINE)}-baseline.sql`, SCHEMA)
    files.set('src/steps.rs', `// Written by web/test/rust-migrations.test.ts from api/migrations and the frozen steps of web/server/utils/migrations
// (ORR-931): don't edit it, run that.
use crate::migrate::Step;

/// SQLite's steps, each bringing \`PRAGMA user_version\` up one.
#[rustfmt::skip]
pub const SQLITE: &[Step] = &[
${list('sqlite', [...SQLITE_FROZEN, ...sqlite], 0)}
];

/// SQLite's step Postgres's baseline matches.
pub const POSTGRES_BASELINE: u32 = ${BASELINE};

/// Postgres's schema at that step, laid down on an empty database.
pub const POSTGRES_SCHEMA: &str = include_str!("../migrations/postgres/${pad(BASELINE)}-baseline.sql");

/// Postgres's steps after the baseline, each bringing \`schema_version\` up one.
#[rustfmt::skip]
pub const POSTGRES: &[Step] = &[
${list('postgres', [...POSTGRES_FROZEN, ...postgres], BASELINE)}
];
`)
    const strings = (steps: string[]) => steps.length ? `[\n${steps.map(step => `    ${JSON.stringify(step)},`).join('\n')}\n]` : '[]'
    files.set(`web/${FROM_API}`, `// Written by test/rust-migrations.test.ts from api/migrations (ORR-931): don't edit it, run that.
// The Rust API's steps after the frozen ones in sqlite.ts and postgres.ts, for this server to run without the binary.

/** SQLite's steps after sqlite.ts's. */
export const SQLITE_FROM_API: string[] = ${strings(sqlite)}

/** Postgres's steps after postgres.ts's. */
export const POSTGRES_FROM_API: string[] = ${strings(postgres)}
`)
    return files
}

/** Where a file of expected()'s is on disk. */
const pathOf = (path: string) => path.startsWith('web/') ? join(WEB, path.slice(4)) : join(API, path)

/** Those files as they are on disk. */
function onDisk(): Map<string, string> {
    const files = new Map<string, string>()
    for (const dir of ['sqlite', 'postgres']) {
        const at = join(API, 'migrations', dir)
        if (!existsSync(at)) continue
        for (const name of readdirSync(at)) files.set(`migrations/${dir}/${name}`, readFileSync(join(at, name), 'utf8'))
    }
    for (const path of ['src/steps.rs', `web/${FROM_API}`]) if (existsSync(pathOf(path))) files.set(path, readFileSync(pathOf(path), 'utf8'))
    return files
}

describe("the Rust API's migrations", () => {
    it('stay frozen in the Node app', () => {
        // A new step goes in api/migrations: see the top of this file.
        expect(SQLITE_FROZEN.length, 'steps in server/utils/migrations/sqlite.ts').toBe(HANDED_OVER.sqlite)
        expect(BASELINE + POSTGRES_FROZEN.length, 'steps in server/utils/migrations/postgres.ts').toBe(HANDED_OVER.postgres)
    })

    it('are the same steps in Rust and in Node', () => {
        const want = expected()
        if (process.env.ORRERY_WRITE_MIGRATIONS === '1') {
            for (const [path, text] of want) {
                mkdirSync(join(pathOf(path), '..'), {recursive: true})
                writeFileSync(pathOf(path), text)
            }
        }
        const have = onDisk()
        // A frozen step is never edited, and the rest are written from api/migrations: see the top of this file.
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

    it('upgrades the file in place, leaving no copy of it beside it', () => {
        const path = nodeSqlite(BEFORE_PEOPLE)
        const run = spawnSync(BIN, ['migrate'], {env: {...process.env, NUXT_DATABASE: path}, encoding: 'utf8'})
        expect(run.status, run.stderr).toBe(0)
        expect(readdirSync(dirname(path)).filter(name => !name.startsWith('orrery.db'))).toEqual([])
        expect(sqliteState(path).step).toBe(MIGRATIONS.length)
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

    it('says what it did on stdout, for the Nuxt server to log (ORR-931)', () => {
        const path = nodeSqlite(BEFORE_PEOPLE)
        const run = spawnSync(BIN, ['migrate'], {env: {...process.env, NUXT_DATABASE: path, ORRERY_API_STEPS: String(MIGRATIONS.length)}, encoding: 'utf8'})
        expect(run.status, run.stderr).toBe(0)
        expect(JSON.parse(run.stdout)).toEqual({from: BEFORE_PEOPLE, to: MIGRATIONS.length})
    })

    it('migrates nothing when its steps end elsewhere than the caller\'s', () => {
        const path = nodeSqlite(BEFORE_PEOPLE)
        const run = spawnSync(BIN, ['migrate'], {env: {...process.env, NUXT_DATABASE: path, ORRERY_API_STEPS: String(MIGRATIONS.length + 1)}, encoding: 'utf8'})
        expect(run.status).toBe(3)
        expect(run.stderr).toMatch(`end at schema step ${MIGRATIONS.length}, not ${MIGRATIONS.length + 1}`)
        expect(sqliteState(path).step).toBe(BEFORE_PEOPLE)
        expect(readdirSync(dirname(path))).toEqual(['orrery.db'])
    })

    it('is what the Nuxt server opens a database with, falling back to its own steps on a mismatched build', () => {
        vi.stubGlobal('useRuntimeConfig', () => ({public: {version: '9.9.9'}}))
        try {
            const path = nodeSqlite(BEFORE_PEOPLE)
            expect(migrateWithApi(path, MIGRATIONS.length, BIN)).toEqual({from: BEFORE_PEOPLE, to: MIGRATIONS.length})
            expect(sqliteState(path).step).toBe(MIGRATIONS.length)
            expect(readdirSync(dirname(path)).filter(name => !name.startsWith('orrery.db'))).toEqual([])
            expect(migrateWithApi(path, MIGRATIONS.length, BIN)).toBeNull()
            const stale = nodeSqlite(BEFORE_PEOPLE)
            const said = vi.spyOn(console, 'error').mockImplementation(() => {})
            expect(migrateWithApi(stale, MIGRATIONS.length - 1, BIN)).toBeUndefined()
            expect(migrateWithApi(stale, MIGRATIONS.length, join(dirname(stale), 'no-such-binary'))).toBeUndefined()
            expect(said).toHaveBeenCalledTimes(2)
            said.mockRestore()
            expect(sqliteState(stale).step).toBe(BEFORE_PEOPLE)
            const newer = nodeSqlite(MIGRATIONS.length, db => db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`))
            expect(() => migrateWithApi(newer, MIGRATIONS.length, BIN)).toThrow('written by a newer orrery')
        } finally {
            vi.unstubAllGlobals()
        }
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
