import {existsSync, mkdirSync, mkdtempSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import pg from 'pg'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Db} from '../server/utils/database'
import {Store} from '../server/utils/store'

/** A data folder of its own, NUXT_DATABASE its `orrery.db`, and db.ts and move.ts loaded fresh for it. */
async function setUp() {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-move-'))
    vi.stubGlobal('useRuntimeConfig', () => ({database: join(dir, 'orrery.db'), backupDir: ''}))
    vi.resetModules()
    const db = await import('../server/utils/db')
    const move = await import('../server/utils/move')
    const store = new Store(db.useDatabase())
    await store.createProject({name: 'Greenhouse', key: 'GRE'}, {name: 'skoll', owner: true})
    await store.createIssue('greenhouse', {title: 'Shelf labels'})
    return {dir, db, move, store}
}

const rebound: Db[] = []
const rebind = (db: Db) => void rebound.push(db)

beforeEach(() => {
    rebound.length = 0
})

afterEach(() => {
    vi.doUnmock('../server/utils/actor')
})

describe('moving the database', () => {
    it('reads a file named alone as one in the data folder, and asks which kind', async () => {
        const {dir, move} = await setUp()
        expect(move.targetOf({kind: 'sqlite', path: 'orrery-2.db'})).toBe(join(dir, 'orrery-2.db'))
        expect(move.targetOf({kind: 'sqlite', path: '/elsewhere/o.db'})).toBe('/elsewhere/o.db')
        expect(move.targetOf({kind: 'postgres', url: ' postgres://u:p@db:5432/o '})).toBe('postgres://u:p@db:5432/o')
        expect(() => move.targetOf({kind: 'mysql', url: 'x'})).toThrow(/"kind"/)
        expect(() => move.targetOf({kind: 'postgres', url: 'http://db'})).toThrow(/needs "url"/)
        expect(() => move.targetOf({kind: 'sqlite', path: dir})).toThrow(/is a folder/)
    })

    it('tells an empty database from an orrery\'s, the one it runs on, and something else\'s', async () => {
        const {dir, move} = await setUp()
        expect(await move.checkDatabase(join(dir, 'new.db'))).toEqual({kind: 'sqlite', where: join(dir, 'new.db'), state: 'empty'})
        expect((await move.checkDatabase(join(dir, 'orrery.db'))).state).toBe('current')
        const other = new DatabaseSync(join(dir, 'other.db'))
        other.exec('CREATE TABLE invoices (id INTEGER)')
        other.close()
        expect((await move.checkDatabase(join(dir, 'other.db'))).state).toBe('other')
        expect(existsSync(join(dir, 'new.db'))).toBe(false)
    })

    it('copies everything into an empty one, runs on it at once, and opens it again on the next start', async () => {
        const {dir, db, move} = await setUp()
        const target = join(dir, 'orrery-2.db')
        const {copied} = await move.moveDatabase(target, 'copy', rebind)
        expect(copied).toMatchObject({projects: 1, issues: 1})
        expect(rebound).toHaveLength(1)
        expect(db.useDatabase()).toBe(rebound[0])
        expect(db.describeDatabase()).toMatchObject({kind: 'sqlite', where: target, movable: true, moved: true})
        expect(JSON.parse(readFileSync(join(dir, 'orrery.db.moved.json'), 'utf8'))).toMatchObject({database: target})
        expect((await new Store(db.useDatabase()).listBoards()).map(p => p.id)).toEqual(['greenhouse'])

        // A fresh start reads where it went.
        vi.resetModules()
        const restarted = await import('../server/utils/db')
        expect(restarted.databaseSetting()).toBe(target)
        await restarted.closeDb()
    })

    it('runs on an orrery\'s own as it is, won\'t copy over it, and going back to its own file forgets the move', async () => {
        const {dir, db, move} = await setUp()
        const target = join(dir, 'orrery-2.db')
        await move.moveDatabase(target, 'copy', rebind)
        const original = join(dir, 'orrery.db')
        await expect(move.moveDatabase(original, 'copy', rebind)).rejects.toThrow(/an orrery's already, with 1 project/)
        await expect(move.moveDatabase(target, 'use', rebind)).rejects.toThrow(/already runs on/)
        await move.moveDatabase(original, 'use', rebind)
        expect(db.databaseSetting()).toBe(original)
        expect(existsSync(join(dir, 'orrery.db.moved.json'))).toBe(false)
        expect(db.describeDatabase().moved).toBeUndefined()
        await db.closeDb()
    })

    it('copies an older orrery\'s file before running on it brings it up to date', async () => {
        const {dir, db, move} = await setUp()
        const older = join(dir, 'older.db')
        const steps = 40
        db.openDb(older, steps).close()
        await move.moveDatabase(older, 'use', rebind)
        const copy = join(dir, `orrery-pre-upgrade-step${steps}.db`)
        expect(existsSync(copy)).toBe(true)
        expect((new DatabaseSync(copy, {readOnly: true}).prepare('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(steps)
        await db.closeDb()
    })

    it('stays whole on the one before when it can\'t save where it went', async () => {
        const {dir, db, move, store} = await setUp()
        const before = db.useDatabase()
        // Where the move is kept is a folder, so writing it fails, as on a full disk.
        mkdirSync(join(dir, 'orrery.db.moved.json'))
        await expect(move.moveDatabase(join(dir, 'orrery-2.db'), 'copy', rebind)).rejects.toThrow()
        expect(rebound).toHaveLength(0)
        expect(db.databaseSetting()).toBe(join(dir, 'orrery.db'))
        expect(db.useDatabase()).toBe(before)
        expect((await store.listBoards()).map(p => p.id)).toEqual(['greenhouse'])
        await db.closeDb()
    })

    it('won\'t run as it is on one that isn\'t an orrery\'s', async () => {
        const {dir, move} = await setUp()
        await expect(move.moveDatabase(join(dir, 'new.db'), 'use', rebind)).rejects.toThrow(/isn't an orrery's yet/)
        expect(rebound).toHaveLength(0)
    })
})

describe('who may move it', () => {
    /** move.ts loaded with the actor a request names, and a request to it by the name `host`, over a connection from
     * `from`. */
    async function guard(owner: boolean, host: string, database?: string, from = '127.0.0.1') {
        const {move} = await setUp()
        if (database) vi.stubGlobal('useRuntimeConfig', () => ({database, backupDir: ''}))
        vi.doMock('../server/utils/actor', () => ({actorOf: async () => ({name: owner ? 'skoll' : 'claude', owner})}))
        vi.resetModules()
        const fresh = await import('../server/utils/move')
        const event = {node: {req: {headers: {host}, socket: {remoteAddress: from}}}} as never
        return {move, check: () => fresh.mayMove(event)}
    }

    async function status(call: () => Promise<unknown>): Promise<number | 'ok'> {
        try {
            await call()
            return 'ok'
        } catch (error) {
            return (error as {statusCode: number}).statusCode
        }
    }

    it('is the owner, on the machine orrery runs on', async () => {
        for (const host of ['localhost:9010', '127.0.0.1:9010', '[::1]:9010', 'orrery.localhost']) expect(await status((await guard(true, host)).check)).toBe('ok')
    })

    it('is never an agent, nor anyone reaching it by another address', async () => {
        expect(await status((await guard(false, 'localhost:9010')).check)).toBe(403)
        for (const host of ['192.168.1.20:9010', 'mac.lan', 'localhost.evil.com']) expect(await status((await guard(true, host)).check)).toBe(403)
    })

    it("is nobody on another machine, whatever name it says it reached orrery by (the Host header is the caller's)", async () => {
        expect(await status((await guard(true, 'localhost:9010', undefined, '::ffff:127.0.0.1')).check)).toBe('ok')
        for (const from of ['192.168.1.20', '::ffff:192.168.1.20', '10.0.0.7', '']) expect(await status((await guard(true, 'localhost:9010', undefined, from)).check)).toBe(403)
    })

    it("under nuxt dev, whose server's socket has no address, goes by the client its proxy adds last to X-Forwarded-For", async () => {
        await setUp()
        vi.doMock('../server/utils/actor', () => ({actorOf: async () => ({name: 'skoll', owner: true})}))
        vi.resetModules()
        const fresh = await import('../server/utils/move')
        const forwarded = (xff: string) => status(() => fresh.mayMove({node: {req: {headers: {'host': 'localhost:3000', 'x-forwarded-for': xff}, socket: {}}}} as never))
        expect(await forwarded('::1')).toBe('ok')
        expect(await forwarded('127.0.0.1, ::1')).toBe('ok')
        // What the client sent comes first; the proxy's own word is the last.
        expect(await forwarded('127.0.0.1, 192.168.1.20')).toBe(403)
    })

    it('in Docker, where every request comes through the bridge, only while orrery is published on loopback', async () => {
        vi.stubEnv('ORRERY_IMAGE', '1')
        try {
            for (const [listenHost, expected] of [['127.0.0.1', 'ok'], ['0.0.0.0', 403], ['', 403]] as const) {
                const {check} = await guard(true, 'localhost:9000', undefined, '172.17.0.1')
                const config = useRuntimeConfig()
                vi.stubGlobal('useRuntimeConfig', () => ({...config, listenHost}))
                const outcome = await check().then(() => 'ok', (error: {statusCode: number, message: string}) => error)
                if (expected === 'ok') expect(outcome).toBe('ok')
                else expect(outcome).toMatchObject({statusCode: 403, message: expect.stringContaining('ORRERY_HOST')})
            }
        } finally {
            vi.unstubAllEnvs()
        }
    })

    it('is nobody while ORRERY_DATABASE names Postgres: it changes where that is set', async () => {
        expect(await status((await guard(true, 'localhost:9010', 'postgres://u:p@db:5432/o')).check)).toBe(409)
    })
})

describe.runIf(process.env.TEST_POSTGRES_URL)('moving to Postgres', () => {
    it('copies everything into an empty database and runs on it, then sees it as the one it runs on', async () => {
        const schema = `test_move_${Date.now().toString(36)}`
        const admin = new pg.Client({connectionString: process.env.TEST_POSTGRES_URL})
        await admin.connect()
        await admin.query(`CREATE SCHEMA "${schema}"`)
        const url = new URL(process.env.TEST_POSTGRES_URL!)
        url.searchParams.set('options', `-c search_path=${schema}`)
        const {db, move} = await setUp()
        try {
            expect((await move.checkDatabase(url.toString())).state).toBe('empty')
            const {copied} = await move.moveDatabase(url.toString(), 'copy', rebind)
            expect(copied).toMatchObject({projects: 1, issues: 1})
            expect(db.describeDatabase()).toMatchObject({kind: 'postgres', moved: true})
            if (url.password) expect(db.describeDatabase().where).not.toContain(`:${url.password}@`)
            expect((await new Store(db.useDatabase()).listBoards()).map(p => p.id)).toEqual(['greenhouse'])
            expect((await move.checkDatabase(url.toString())).state).toBe('current')
        } finally {
            await db.closeDb()
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
            await admin.end()
        }
    })
})
