// The database: its schema and backups, and importing a roadmap. The store, against a fresh database with the project
// `greenhouse` (store-setup.ts).
import {mkdtempSync, readFileSync, readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import pg from 'pg'
import {beforeEach, describe, expect, it} from 'vitest'
import {total} from '#shared/roadmap'
import {backUp, backupPostgres, lastBackup} from '../server/utils/backup'
import {openDb} from '../server/utils/db'
import {MIGRATIONS} from '../server/utils/migrations/sqlite'
import {SqliteDb} from '../server/utils/database'
import {PostgresDb} from '../server/utils/postgres'
import {readRoadmap} from '../server/utils/roadmap'
import {Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store

beforeEach(async () => {
    ({store} = await storeSetup())
})

describe('the database', () => {
    it("makes letting orrery start sessions the orrery's one setting, from the first project that had it", async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 34)
        old.prepare(`INSERT INTO projects (id, name, key, starts, created_by, created_at, updated_at) VALUES
            ('greenhouse', 'greenhouse', 'GRE', NULL, 'agent', '1', '1'), ('pantry', 'pantry', 'PAN', '{"limit":2,"minutes":60}', 'agent', '2', '2'),
            ('cellar', 'cellar', 'CEL', '{"limit":5}', 'agent', '3', '3')`).run()
        old.close()
        const upgraded = new Store(new SqliteDb(openDb(path)))
        expect((await upgraded.settings()).starts).toEqual({limit: 2, minutes: 60})
        expect((await upgraded.project('greenhouse')).starts).toEqual({limit: 2, minutes: 60})
        const none = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'none.db')
        openDb(none, 34).close()
        expect((await new Store(new SqliteDb(openDb(none))).settings()).starts).toBeNull()
    })

    it('puts the proposals approved before on the roadmap, in Todo', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 30)
        old.prepare("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x')").run()
        old.prepare("INSERT INTO issues (project, id, title, status, proposal, decided_by, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'GRE-1', 'A', 'backlog', 'approved', 'skoll', 0, 'agent', 'x', 'x'), ('greenhouse', 'GRE-2', 'B', 'backlog', 'pending', NULL, 1, 'agent', 'x', 'x'), ('greenhouse', 'GRE-3', 'C', 'done', 'approved', 'skoll', 2, 'agent', 'x', 'x')").run()
        old.close()
        const upgraded = new Store(new SqliteDb(openDb(path)))
        expect([(await upgraded.issue('greenhouse', 'GRE-1')).column, (await upgraded.issue('greenhouse', 'GRE-1')).decided_by]).toEqual(['todo', 'skoll'])
        expect((await upgraded.issue('greenhouse', 'GRE-2')).proposal).toBe('pending')
        // One its work already finished stays done.
        expect((await upgraded.issue('greenhouse', 'GRE-3'))).toMatchObject({column: 'done', proposal: undefined})
    })

    it("keeps the orrery's prompts through the API going snake_case", async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 27)
        old.prepare(`INSERT INTO settings (key, value) VALUES ('focusPrompt', '"Look at {issue}"'), ('chunkPrompt', '"Work {chunk}"')`).run()
        old.close()
        expect(await new Store(new SqliteDb(openDb(path))).settings()).toMatchObject({focus_prompt: 'Look at {issue}', chunk_prompt: 'Work {chunk}'})
    })

    it('keeps its data through the migrations and gives it project ids, the old ones as aliases', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 2)
        const row = (sql: string) => old.prepare(sql).run()
        row("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x')")
        row("INSERT INTO chunks (project, id, title, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'ux', 'UX', 1, 'agent', 'x', 'x')")
        row("INSERT INTO chunks (project, id, title, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'joints', 'Joints', 0, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, chunk, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'UX-1', 'ux', 'ux', 0, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, chunk, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'MOT-5', 'joint', 'joints', 1, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, parent, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'GRE-1', 'sub', 'MOT-5', 2, 'agent', 'x', 'x')")
        row("INSERT INTO comments (project, issue, body, created_by, created_at, updated_at) VALUES ('greenhouse', 'MOT-5', 'hi', 'agent', 'x', 'x')")
        old.close()

        const upgraded = new Store(new SqliteDb(openDb(path)))
        const {board} = await upgraded.project('greenhouse')
        expect(board.chunks.map(c => [c.id, c.title, c.aliases])).toEqual([['1', 'Joints', ['joints']], ['2', 'UX', ['ux']]])
        // GRE-1 was already the project's kind of id, so it keeps it; the others take the next numbers.
        expect(board.chunks[0]!.tasks.map(t => [t.id, t.aliases, t.tasks.map(s => s.id)])).toEqual([['GRE-2', ['MOT-5'], ['GRE-1']]])
        expect(board.chunks[1]!.tasks.map(t => [t.id, t.aliases])).toEqual([['GRE-3', ['UX-1']]])
        expect((await upgraded.issue('greenhouse', 'MOT-5')).id).toBe('GRE-2')
        expect((await upgraded.listComments('greenhouse', 'MOT-5')).map(c => c.body)).toEqual(['hi'])
        expect((await upgraded.chunk('greenhouse', 'joints')).id).toBe('1')
        expect(await upgraded.createIssue('greenhouse', {title: 'new', chunk: 'ux'})).toMatchObject({id: 'GRE-4', chunk: '2'})
        expect((await upgraded.createChunk('greenhouse', {title: 'Print'})).id).toBe('3')
        expect((await upgraded.updateIssue('greenhouse', 'GRE-4', {priority: 'P0'})).priority).toBe('P0')
    })

    it('keeps a schedule\'s presets, runs and what it holds through the rebuild for action schedules', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, MIGRATIONS.length - 1)
        const row = (sql: string) => old.prepare(sql).run()
        row("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x')")
        row(`INSERT INTO schedules (id, project, kind, title, on_event, presets, timezone, created_by, owned, created_at, updated_at)
            VALUES (7, 'greenhouse', 'session', 'Review', 'issue.status', '[3]', 'UTC', 'skoll', 1, 'x', 'x')`)
        row("INSERT INTO schedule_runs (schedule, at, outcome, subject) VALUES (7, 'x', 'sent', 'GRE-1')")
        row("INSERT INTO schedule_held (schedule, subject, event, at) VALUES (7, 'GRE-2', '{}', 'x')")
        old.close()

        const upgraded = new SqliteDb(openDb(path))
        expect(await upgraded.get('SELECT kind, presets, move_from FROM schedules WHERE id = 7')).toEqual({kind: 'session', presets: '[3]', move_from: '[]'})
        expect(await upgraded.get('SELECT count(*) AS n FROM schedule_runs WHERE schedule = 7')).toEqual({n: 1})
        expect(await upgraded.get('SELECT count(*) AS n FROM schedule_held WHERE schedule = 7')).toEqual({n: 1})
    })

    it('moves a named owner from settings to people, and leaves an unnamed one as they are (ORR-653)', async () => {
        const open = (name?: string) => {
            const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
            const old = openDb(path, MIGRATIONS.length - 1)
            if (name) old.prepare("INSERT INTO settings (key, value) VALUES ('owner', ?)").run(JSON.stringify(name))
            old.close()
            return new Store(new SqliteDb(openDb(path)))
        }
        const named = open('Sköll Fenrisson')
        expect(await named.ownerOf()).toEqual({name: 'skoll_fenrisson', display: 'Sköll Fenrisson', named: true})
        expect(await named.people()).toMatchObject([{id: 'skoll_fenrisson', name: 'Sköll Fenrisson', role: 'owner'}])
        expect(await named.db.get("SELECT 1 FROM settings WHERE key = 'owner'")).toBeUndefined()
        const unnamed = open()
        expect((await unnamed.ownerOf()).named).toBe(false)
        expect(await unnamed.people()).toEqual([])
    })

    it('copies itself before an upgrade takes steps, and only then', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
        const path = join(dir, 'orrery.db')
        const snapshot = join(dir, 'backup', 'orrery-pre-1.0.0.db')
        const taken = join(dir, 'backup', 'orrery-pre-1.0.0-step40.db')
        // A new file has nothing to keep.
        openDb(path, 40, snapshot).close()
        expect(readdirSync(dir)).not.toContain('backup')
        const old = openDb(path, 40)
        old.prepare("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x')").run()
        old.close()

        openDb(path, undefined, snapshot).close()
        const copy = new DatabaseSync(taken)
        expect((copy.prepare('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(40)
        expect(copy.prepare('SELECT id FROM projects').all().map(row => row.id)).toEqual(['greenhouse'])
        copy.close()
        // Up to date, it takes no copy.
        openDb(path, undefined, join(dir, 'backup', 'orrery-pre-1.0.1.db')).close()
        expect(readdirSync(join(dir, 'backup'))).toEqual(['orrery-pre-1.0.0-step40.db'])
    })

    it('takes a fresh copy for each step an upgrade starts from, under the same version (ORR-457)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
        const path = join(dir, 'orrery.db')
        const snapshot = join(dir, 'backup', 'orrery-pre-1.0.0-rc.10.db')
        openDb(path, 39).close()
        openDb(path, 40, snapshot).close()
        openDb(path, undefined, snapshot).close()
        expect(readdirSync(join(dir, 'backup')).sort()).toEqual(['orrery-pre-1.0.0-rc.10-step39.db', 'orrery-pre-1.0.0-rc.10-step40.db'])
    })

    it('refuses a database from a newer orrery and leaves it as it is', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'orrery.db')
        const raw = openDb(path)
        const newest = (raw.prepare('PRAGMA user_version').get() as {user_version: number}).user_version
        raw.exec(`PRAGMA user_version = ${newest + 1}`)
        raw.close()
        expect(() => openDb(path)).toThrow(`was written by a newer orrery (schema step ${newest + 1}; this one knows up to ${newest})`)
        const after = new DatabaseSync(path)
        expect((after.prepare('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(newest + 1)
        after.close()
    })

    it.runIf(process.env.TEST_POSTGRES_URL)('refuses a Postgres database from a newer orrery', async () => {
        const schema = `test_newer_${Date.now().toString(36)}`
        const first = new PostgresDb(process.env.TEST_POSTGRES_URL!, schema)
        const {version} = (await first.get<{version: number}>('SELECT version FROM schema_version'))!
        await first.run('UPDATE schema_version SET version = ?', version + 1)
        await first.close()
        const second = new PostgresDb(process.env.TEST_POSTGRES_URL!, schema)
        await expect(second.get('SELECT 1')).rejects.toThrow(`newer orrery (schema step ${version + 1}; this one knows up to ${version})`)
        await second.close()
        const cleanup = new pg.Client({connectionString: process.env.TEST_POSTGRES_URL})
        await cleanup.connect()
        await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`)
        await cleanup.end()
    })

    // On Postgres as a SQLite snapshot, so a new SQLite orrery starts from it either way.
    it('is backed up to a folder and restored from it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
        const cloud = join(dir, 'cloud')
        const {id} = await store.createIssue('greenhouse', {title: 'saved'})
        expect(lastBackup(cloud)).toBeUndefined()
        // Two at once: the second waits for the first rather than writing over it.
        await Promise.all([backUp(store.db, cloud), backUp(store.db, cloud)])
        expect(lastBackup(cloud)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        // One file each, the latest and today's, with nothing left beside them.
        expect(readdirSync(cloud).sort()).toEqual(['orrery.db', `orrery-${new Date().toISOString().slice(0, 10)}.db`].sort())

        expect((await new Store(new SqliteDb(openDb(join(cloud, 'orrery.db')))).issue('greenhouse', id)).title).toBe('saved')
    })

    it("is copied whole into a SQLite snapshot, as a Postgres one is, whatever it's on", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'cloud')
        const {id} = await store.createIssue('greenhouse', {title: 'snapped'})
        await backupPostgres(store.db, dir)
        expect(readdirSync(dir)).toContain('orrery.db')
        expect(readdirSync(dir).filter(name => name.includes('partial') || name.endsWith('-wal'))).toEqual([])
        expect((await new Store(new SqliteDb(openDb(join(dir, 'orrery.db')))).issue('greenhouse', id)).title).toBe('snapped')

        // Each from the schema laid down once, up to date, with nothing of the last one left in it.
        await store.updateIssue('greenhouse', id, {title: 'snapped again'})
        await backupPostgres(store.db, dir)
        const again = new DatabaseSync(join(dir, 'orrery.db'))
        const version = (raw: DatabaseSync) => (raw.prepare('PRAGMA user_version').get() as {user_version: number}).user_version
        expect(version(again)).toBe(version(openDb(':memory:')))
        expect(again.prepare('SELECT title FROM issues').all().map(row => row.title)).toEqual(['snapped again'])
    })
})
describe('import', () => {
    const roadmap = readRoadmap(readFileSync(new URL('./fixtures/greenhouse-roadmap.json', import.meta.url), 'utf8'))

    it("loads greenhouse's roadmap", async () => {
        expect((await failure(() => store.importRoadmap('greenhouse', roadmap))).status).toBe(409)
        const {board} = await store.importRoadmap('greenhouse', roadmap, true)
        expect(board.chunks).toHaveLength(16)
        expect(total(board.kinds)).toBe(139)
        // Chunk 1 was the one it replaced, so its number isn't handed out again.
        expect(board.chunks.map(c => c.id)).toEqual(Array.from({length: 16}, (_, i) => String(i + 2)))
        expect(board.chunks[0]!.tasks[0]).toMatchObject({id: 'GRE-1', aliases: ['FIX-1']})
        expect((await store.issue('greenhouse', 'MOT-5')).aliases).toEqual(['MOT-5'])
        expect((await store.createIssue('greenhouse', {title: 'next'})).id).toBe('GRE-140')
    })

    it('replacing never hands out a number again, and lets go of what pointed at the replaced issues', async () => {
        const owner = {name: 'skoll', owner: true}
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves'})).id
        await store.createIssue('greenhouse', {title: 'Jars'})
        await store.focus('greenhouse', shelves, {}, owner)
        await store.focusChunk('greenhouse', '1', {}, owner)
        const file = readRoadmap(JSON.stringify({chunks: [{id: 'new', title: 'New', tasks: [{id: 'lids', title: 'Lids', status: 'todo'}]}]}))
        const {board} = await store.importRoadmap('greenhouse', file, true)
        expect(board.chunks.map(c => c.id)).toEqual(['2'])
        expect(board.chunks[0]!.tasks.map(t => t.id)).toEqual(['GRE-3'])
        expect(await store.listSignals('greenhouse')).toEqual([])
        expect((await store.createIssue('greenhouse', {title: 'next'})).id).toBe('GRE-4')
    })
})
