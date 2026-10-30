// SQLite's migrations (db.ts) and Postgres's (postgres.ts) are two lists that have to end in the same schema, and
// Postgres's steps that change data have to keep it as SQLite's do (ORR-499). Both need TEST_POSTGRES_URL, as CI sets.
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {DatabaseSync} from 'node:sqlite'
import pg from 'pg'
import {afterEach, describe, expect, it} from 'vitest'
import {COPIED_TABLES} from '../server/utils/copy'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {PostgresDb} from '../server/utils/postgres'
import {Store} from '../server/utils/store'

const url = process.env.TEST_POSTGRES_URL!

/** A table as both databases can describe it: its columns (NOT NULL, default without Postgres's casts), its indexes
 * other than the primary key (columns, unique), and how many CHECKs it has. Column order isn't part of it: an added
 * column lands last in one and in its place in the other's baseline. */
interface Table {
    columns: Record<string, {notNull: boolean, default: string | null}>
    indexes: string[]
    checks: number
}

const uncast = (value: string | null) => value?.replace(/::[a-z ]+/g, '') ?? null

function sqliteSchema(db: DatabaseSync): {step: number, tables: Record<string, Table>} {
    const tables: Record<string, Table> = {}
    for (const {name, sql} of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {name: string, sql: string}[]) {
        const columns = db.prepare(`PRAGMA table_info(${name})`).all() as {name: string, notnull: number, pk: number, dflt_value: string | null}[]
        const indexes = (db.prepare(`PRAGMA index_list(${name})`).all() as {name: string, unique: number, origin: string}[]).filter(i => i.origin !== 'pk')
        tables[name] = {
            columns: Object.fromEntries(columns.map(c => [c.name, {notNull: !!c.notnull || !!c.pk, default: c.dflt_value}])),
            indexes: indexes.map(i => `${(db.prepare(`PRAGMA index_info("${i.name}")`).all() as {name: string}[]).map(c => c.name).join(',')}${i.unique ? ' unique' : ''}`).sort(),
            checks: sql.match(/\bCHECK\s*\(/gi)?.length ?? 0,
        }
    }
    return {step: (db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version, tables}
}

async function postgresSchema(db: PostgresDb, schema: string): Promise<{step: number, tables: Record<string, Table>}> {
    const tables: Record<string, Table> = {}
    for (const {table_name: name} of await db.all<{table_name: string}>("SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name <> 'schema_version'", schema)) {
        const columns = await db.all<{column_name: string, is_nullable: string, column_default: string | null}>(
            'SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = ?', schema, name)
        const indexes = await db.all<{columns: string, unique: boolean}>(`SELECT ix.indisunique AS unique, array_to_string(array(SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY k(n, o)
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.n ORDER BY k.o), ',') AS columns
            FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
            WHERE ns.nspname = ? AND t.relname = ? AND NOT ix.indisprimary`, schema, name)
        const checks = await db.get<{n: number}>(`SELECT count(*) AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
            WHERE ns.nspname = ? AND t.relname = ? AND c.contype = 'c'`, schema, name)
        tables[name] = {
            columns: Object.fromEntries(columns.map(c => [c.column_name, {notNull: c.is_nullable === 'NO', default: uncast(c.column_default)}])),
            indexes: indexes.map(i => `${i.columns}${i.unique ? ' unique' : ''}`).sort(),
            checks: checks!.n,
        }
    }
    return {step: (await db.get<{version: number}>('SELECT version FROM schema_version'))!.version, tables}
}

/** The schemas these tests made, dropped after each one; and their pools, closed first. */
const made: {db: PostgresDb, schema: string}[] = []
const schemaName = () => `parity_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
function postgres(schema: string, upTo?: number) {
    const db = new PostgresDb(url, schema, upTo)
    made.push({db, schema})
    return db
}
afterEach(async () => {
    if (!made.length) return
    const schemas = new Set(made.map(m => m.schema))
    await Promise.all(made.splice(0).map(m => m.db.close()))
    const admin = new pg.Client({connectionString: url})
    await admin.connect()
    try {
        for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
        await admin.end()
    }
})

describe.runIf(url)('SQLite and Postgres', () => {
    it('reach the same step, with the same tables, columns, indexes and checks', async () => {
        const schema = schemaName()
        const lite = sqliteSchema(openDb(':memory:'))
        const other = await postgresSchema(postgres(schema), schema)
        expect(other.step).toBe(lite.step)
        expect(Object.keys(other.tables).sort()).toEqual(Object.keys(lite.tables).sort())
        for (const [name, table] of Object.entries(lite.tables)) expect(other.tables[name], name).toEqual(table)
    })

    it('copy every table Postgres has', async () => {
        const schema = schemaName()
        const {tables} = await postgresSchema(postgres(schema), schema)
        expect(Object.keys(tables).sort()).toEqual([...COPIED_TABLES].sort())
    })
})

/** A Postgres database at `step` with `rows` written into it, then opened again, upgraded, behind a store. */
async function upgraded(step: number, rows: string) {
    const schema = schemaName()
    const old = postgres(schema, step)
    await old.exec(rows)
    expect((await old.get<{version: number}>('SELECT version FROM schema_version'))!.version).toBe(step)
    return new Store(postgres(schema))
}

const PROJECT = "INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x');"

// Each step that changes data ran only on empty tables until these; SQLite's twins are in store.test.ts.
// An orrery from before people (ORR-659): every project is the owner's, every issue keeps its assignee, and nothing is orphaned.
const BEFORE_PEOPLE_STEP = 62
const BEFORE_PEOPLE = `INSERT INTO settings (key, value) VALUES ('owner', '"Skoll"');
            INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x'), ('cellar', 'cellar', 'CEL', 'agent', 'x', 'x');
            INSERT INTO issues (project, id, title, status, position, assignee, created_by, created_at, updated_at) VALUES
            ('greenhouse', 'GRE-1', 'A', 'todo', 0, 'claude', 'agent', 'x', 'x'), ('greenhouse', 'GRE-2', 'B', 'todo', 1, 'somebody', 'agent', 'x', 'x'), ('cellar', 'CEL-1', 'C', 'todo', 0, NULL, 'agent', 'x', 'x');`
async function expectPeopleUpgraded(store: Store) {
    expect((await store.people()).map(p => p.id)).toEqual(['skoll'])
    for (const project of ['greenhouse', 'cellar']) expect((await store.members(project)).map(m => [m.person, m.role])).toEqual([['skoll', 'owner']])
    expect((await store.issue('greenhouse', 'GRE-1')).assignee).toBe('claude')
    expect((await store.issue('greenhouse', 'GRE-2')).assignee).toBe('somebody')
    expect((await store.issue('cellar', 'CEL-1')).assignee).toBeUndefined()
    expect(await store.db.get(`SELECT project FROM project_members WHERE project NOT IN (SELECT id FROM projects) OR person NOT IN (SELECT id FROM people)`)).toBeUndefined()
}

describe.runIf(url)('upgrading Postgres with data in it', () => {
    // It keeps no copy before upgrading, as SQLite does, so these are what it relies on instead (ORR-733).
    it('leaves it as it was when a step fails, with its rows, at its step', async () => {
        const schema = schemaName()
        const old = postgres(schema, BEFORE_PEOPLE_STEP)
        await old.exec(`${BEFORE_PEOPLE} DROP TABLE docs CASCADE;`)
        await expect(postgres(schema).get('SELECT 1')).rejects.toThrow(/docs/)
        const after = postgres(schema, BEFORE_PEOPLE_STEP)
        expect(await after.get('SELECT version FROM schema_version')).toEqual({version: BEFORE_PEOPLE_STEP})
        expect(await after.get('SELECT count(*)::int AS n FROM issues')).toEqual({n: 3})
    })

    it("refuses one a newer orrery has moved on, and leaves it as it is", async () => {
        const schema = schemaName()
        const newest = postgres(schema)
        await newest.exec(PROJECT)
        await newest.exec('UPDATE schema_version SET version = version + 1')
        const {version} = (await newest.get<{version: number}>('SELECT version FROM schema_version'))!
        await expect(postgres(schema).get('SELECT 1')).rejects.toThrow(/newer orrery/)
        expect(await newest.get('SELECT version FROM schema_version')).toEqual({version})
        expect(await newest.get('SELECT count(*)::int AS n FROM projects')).toEqual({n: 1})
    })

    it('gives every project to the owner, and every issue keeps its assignee (ORR-659)', async () => {
        await expectPeopleUpgraded(await upgraded(BEFORE_PEOPLE_STEP, BEFORE_PEOPLE))
    })

    it("keeps the orrery's prompts through the API going snake_case (step 30)", async () => {
        const store = await upgraded(29, `INSERT INTO settings (key, value) VALUES ('focusPrompt', '"Look at {issue}"'), ('chunkPrompt', '"Work {chunk}"');`)
        expect(await store.settings()).toMatchObject({focus_prompt: 'Look at {issue}', chunk_prompt: 'Work {chunk}'})
    })

    it('moves a named owner from settings to people (ORR-653)', async () => {
        const store = await upgraded(62, `INSERT INTO settings (key, value) VALUES ('owner', '"Sköll Fenrisson"');`)
        expect(await store.ownerOf()).toEqual({name: 'skoll_fenrisson', display: 'Sköll Fenrisson', named: true})
        expect(await store.people()).toMatchObject([{id: 'skoll_fenrisson', role: 'owner'}])
    })

    it('gives each board and the server a random id (ORR-674)', async () => {
        const store = await upgraded(63, `${PROJECT}
            INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('pantry', 'pantry', 'PAN', 'agent', 'x', 'x');`)
        const [a, b] = [(await store.project('greenhouse')).uid, (await store.project('pantry')).uid]
        expect(a).toMatch(/^[a-z2-7]{8}$/)
        expect(b).toMatch(/^[a-z2-7]{8}$/)
        expect(a).not.toBe(b)
        expect((await store.settings()).uid).toMatch(/^[a-z2-7]{8}$/)
    })

    it('gives each project its release mode from the releases it had (step 32)', async () => {
        const store = await upgraded(31, `INSERT INTO projects (id, name, key, releases_from, created_by, created_at, updated_at) VALUES
            ('greenhouse', 'greenhouse', 'GRE', NULL, 'agent', '1', '1'), ('pantry', 'pantry', 'PAN', 'greenhouse', 'agent', '2', '2'),
            ('cellar', 'cellar', 'CEL', NULL, 'agent', '3', '3'), ('attic', 'attic', 'ATT', NULL, 'agent', '4', '4');
            INSERT INTO releases (project, version, created_by, created_at, updated_at) VALUES ('cellar', '1.0', 'agent', 'x', 'x');`)
        expect(await Promise.all(['greenhouse', 'pantry', 'cellar', 'attic'].map(async id => (await store.project(id)).release_mode)))
            .toEqual(['own', 'shared', 'own', 'none'])
    })

    it('puts the proposals approved before on the roadmap, in Todo (step 33)', async () => {
        const store = await upgraded(32, `${PROJECT}
            INSERT INTO issues (project, id, title, status, proposal, decided_by, position, created_by, created_at, updated_at) VALUES
            ('greenhouse', 'GRE-1', 'A', 'backlog', 'approved', 'skoll', 0, 'agent', 'x', 'x'), ('greenhouse', 'GRE-2', 'B', 'backlog', 'pending', NULL, 1, 'agent', 'x', 'x'),
            ('greenhouse', 'GRE-3', 'C', 'done', 'approved', 'skoll', 2, 'agent', 'x', 'x');`)
        expect(await store.issue('greenhouse', 'GRE-1')).toMatchObject({column: 'todo', decided_by: 'skoll'})
        expect((await store.issue('greenhouse', 'GRE-2')).proposal).toBe('pending')
        expect(await store.issue('greenhouse', 'GRE-3')).toMatchObject({column: 'done', proposal: undefined})
    })

    it('arranges the releases there were: unshipped first, then the latest shipped (step 34)', async () => {
        const store = await upgraded(33, `INSERT INTO projects (id, name, key, release_mode, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'own', 'agent', 'x', 'x');
            INSERT INTO releases (project, version, shipped_on, created_by, created_at, updated_at) VALUES
            ('greenhouse', '0.1', '2026-01-01', 'agent', '1', '1'), ('greenhouse', '0.2', '2026-02-01', 'agent', '2', '2'),
            ('greenhouse', '0.3', NULL, 'agent', '3', '3'), ('greenhouse', '0.4', NULL, 'agent', '4', '4');`)
        expect((await store.listReleases('greenhouse')).map(r => r.version)).toEqual(['0.4', '0.3', '0.2', '0.1'])
    })

    it("makes letting orrery start sessions the orrery's one setting, from the first project that had it (step 37)", async () => {
        const store = await upgraded(36, `INSERT INTO projects (id, name, key, starts, created_by, created_at, updated_at) VALUES
            ('greenhouse', 'greenhouse', 'GRE', NULL, 'agent', '1', '1'), ('pantry', 'pantry', 'PAN', '{"limit":2,"minutes":60}', 'agent', '2', '2'),
            ('cellar', 'cellar', 'CEL', '{"limit":5}', 'agent', '3', '3');`)
        expect((await store.settings()).starts).toEqual({limit: 2, minutes: 60})
        expect((await store.project('greenhouse')).starts).toEqual({limit: 2, minutes: 60})
    })

    it("moves the GitHub issues' links out of external, into github_issues (ORR-635)", async () => {
        const store = await upgraded(GITHUB_LINKS_STEP, GITHUB_LINKS)
        expect(await store.issue('greenhouse', 'GRE-1')).toMatchObject({external: ['ENG-1'], github_issues: ['you/greenhouse#223', 'other/lib#7']})
        expect(await store.issue('greenhouse', 'GRE-2')).toMatchObject({external: ['https://github.com/you/greenhouse/issues/12#issuecomment-1', 'https://github.com/you/greenhouse/pull/9'], github_issues: []})
        expect(await store.issue('greenhouse', 'GRE-3')).toMatchObject({external: ['ENG-2'], github_issues: []})
    })

    it("starts each doc's history from its text, and marks no release shipped before (ORR-675)", async () => {
        await expectDocHistoryStarted(await upgraded(DOC_REVISIONS_STEP, DOCS_BEFORE_REVISIONS))
    })
})

/** The step before ORR-675's. */
const DOC_REVISIONS_STEP = 64
const DOCS_BEFORE_REVISIONS = `INSERT INTO projects (id, name, key, release_mode, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'own', 'agent', 'x', 'x');
            INSERT INTO releases (project, version, shipped_on, created_by, created_at, updated_at) VALUES ('greenhouse', '1.0', '2026-01-01', 'agent', 'x', 'x');
            INSERT INTO docs (project, id, title, body, position, created_by, owned, created_at, updated_at) VALUES
            ('greenhouse', 'later', 'Later', 'b', 0, 'skoll', 1, 'c1', 'u2'),
            ('greenhouse', 'first', 'First', 'a', 1, 'agent', 0, 'c2', 'u1');`

async function expectDocHistoryStarted(store: Store) {
    const [first] = await store.docRevisions('greenhouse', 'first')
    const [later] = await store.docRevisions('greenhouse', 'later')
    expect(first).toMatchObject({title: 'First', created_by: 'agent', created_at: 'u1', deleted: false})
    expect(later).toMatchObject({title: 'Later', created_by: 'skoll', created_at: 'u2'})
    expect(first!.id).toBeLessThan(later!.id)
    expect((await store.docRevision('greenhouse', 'later', later!.id)).body).toBe('b')
    expect((await store.release('greenhouse', '1.0')).doc_mark).toBeUndefined()
}

/** The step before ORR-635's. */
const GITHUB_LINKS_STEP = 58
/** Issues linking GitHub issues in `external`, as they were before ORR-635: whole issue links move, anything else stays. */
const GITHUB_LINKS = `${PROJECT}
            INSERT INTO issues (project, id, title, status, external, position, created_by, created_at, updated_at) VALUES
            ('greenhouse', 'GRE-1', 'A', 'todo', '["ENG-1","https://github.com/you/greenhouse/issues/223","https://github.com/other/lib/issues/7"]', 0, 'agent', 'x', 'x'),
            ('greenhouse', 'GRE-2', 'B', 'todo', '["https://github.com/you/greenhouse/issues/12#issuecomment-1","https://github.com/you/greenhouse/pull/9"]', 1, 'agent', 'x', 'x'),
            ('greenhouse', 'GRE-3', 'C', 'todo', '["ENG-2"]', 2, 'agent', 'x', 'x');`

/** A SQLite file at `step` with `rows` written into it, then opened again, upgraded, behind a store. */
function upgradedSqlite(step: number, rows: string) {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
    const old = openDb(path, step)
    old.exec(rows)
    old.close()
    return new Store(new SqliteDb(openDb(path)))
}

// SQLite's twins of the steps above that had no test on either database.
describe('upgrading SQLite with data in it', () => {
    it('gives every project to the owner, and every issue keeps its assignee (ORR-659)', async () => {
        await expectPeopleUpgraded(upgradedSqlite(BEFORE_PEOPLE_STEP, BEFORE_PEOPLE))
    })

    it("keeps the docs there were as Markdown, their revisions too (ORR-677)", async () => {
        const store = upgradedSqlite(68, `INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x');
            INSERT INTO docs (project, id, title, body, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'first', 'First', 'a', 0, 'agent', 'x', 'x');
            INSERT INTO doc_revisions (project, doc, title, body, created_by, created_at) VALUES ('greenhouse', 'first', 'First', 'a', 'agent', 'x');`)
        expect(await store.doc('greenhouse', 'first')).toMatchObject({kind: 'markdown', summary: 'a'})
        expect((await store.docRevisions('greenhouse', 'first'))[0]).toMatchObject({kind: 'markdown'})
    })

    it("starts each doc's history from its text, and marks no release shipped before (ORR-675)", async () => {
        await expectDocHistoryStarted(upgradedSqlite(DOC_REVISIONS_STEP, DOCS_BEFORE_REVISIONS))
    })

    it('gives each project its release mode from the releases it had (step 32)', async () => {
        const store = upgradedSqlite(31, `INSERT INTO projects (id, name, key, releases_from, created_by, created_at, updated_at) VALUES
            ('greenhouse', 'greenhouse', 'GRE', NULL, 'agent', '1', '1'), ('pantry', 'pantry', 'PAN', 'greenhouse', 'agent', '2', '2'),
            ('cellar', 'cellar', 'CEL', NULL, 'agent', '3', '3'), ('attic', 'attic', 'ATT', NULL, 'agent', '4', '4');
            INSERT INTO releases (project, version, created_by, created_at, updated_at) VALUES ('cellar', '1.0', 'agent', 'x', 'x');`)
        expect(await Promise.all(['greenhouse', 'pantry', 'cellar', 'attic'].map(async id => (await store.project(id)).release_mode)))
            .toEqual(['own', 'shared', 'own', 'none'])
    })

    it('arranges the releases there were: unshipped first, then the latest shipped (step 34)', async () => {
        const store = upgradedSqlite(33, `INSERT INTO projects (id, name, key, release_mode, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'own', 'agent', 'x', 'x');
            INSERT INTO releases (project, version, shipped_on, created_by, created_at, updated_at) VALUES
            ('greenhouse', '0.1', '2026-01-01', 'agent', '1', '1'), ('greenhouse', '0.2', '2026-02-01', 'agent', '2', '2'),
            ('greenhouse', '0.3', NULL, 'agent', '3', '3'), ('greenhouse', '0.4', NULL, 'agent', '4', '4');`)
        expect((await store.listReleases('greenhouse')).map(r => r.version)).toEqual(['0.4', '0.3', '0.2', '0.1'])
    })

    it("moves the GitHub issues' links out of external, into github_issues (ORR-635)", async () => {
        const store = upgradedSqlite(GITHUB_LINKS_STEP, GITHUB_LINKS)
        expect(await store.issue('greenhouse', 'GRE-1')).toMatchObject({external: ['ENG-1'], github_issues: ['you/greenhouse#223', 'other/lib#7']})
        expect(await store.issue('greenhouse', 'GRE-2')).toMatchObject({external: ['https://github.com/you/greenhouse/issues/12#issuecomment-1', 'https://github.com/you/greenhouse/pull/9'], github_issues: []})
        expect(await store.issue('greenhouse', 'GRE-3')).toMatchObject({external: ['ENG-2'], github_issues: []})
    })
})
