import {existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import pg from 'pg'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {PostgresDb} from '../server/utils/postgres'
import {Store} from '../server/utils/store'

/** A data folder of its own, NUXT_DATABASE its `orrery.db` and NUXT_BACKUP_DIR `backupDir`, and db.ts and
 * backup-choice.ts loaded fresh for it. */
async function setUp(backupDir = '') {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-backups-'))
    vi.stubGlobal('useRuntimeConfig', () => ({database: join(dir, 'data', 'orrery.db'), backupDir: backupDir && join(dir, backupDir)}))
    mkdirSync(join(dir, 'data'))
    vi.resetModules()
    const db = await import('../server/utils/db')
    const choice = await import('../server/utils/backup-choice')
    const store = new Store(db.useDatabase())
    await store.createProject({name: 'Greenhouse', key: 'GRE'}, {name: 'skoll', owner: true})
    return {dir, db, choice}
}

/** What a call answers: `ok`, or the status it was refused with. */
async function status(call: () => Promise<unknown>): Promise<number | 'ok'> {
    try {
        await call()
        return 'ok'
    } catch (error) {
        return (error as {statusCode: number}).statusCode
    }
}

afterEach(() => {
    vi.doUnmock('../server/utils/actor')
})

describe('choosing the backups', () => {
    it('backs up to NUXT_BACKUP_DIR until the owner chooses otherwise', async () => {
        const {dir, db, choice} = await setUp('backup')
        expect(choice.backupDir()).toBe(join(dir, 'backup'))
        expect(db.describeDatabase()).toMatchObject({backup: join(dir, 'backup'), backups_settable: 'folder', backup_default: join(dir, 'backup')})
        expect(db.describeDatabase().backups_off).toBeUndefined()
    })

    it('backs up to a chosen folder at once, keeps it for the next start, and goes back to the default', async () => {
        const {dir, db, choice} = await setUp('backup')
        const folder = join(dir, 'elsewhere')
        await choice.chooseBackups({on: true, folder})
        expect(existsSync(join(folder, 'orrery.db'))).toBe(true)
        expect(db.describeDatabase()).toMatchObject({backup: folder, backup_folder: folder})
        vi.resetModules()
        expect((await import('../server/utils/backup-choice')).backupDir()).toBe(folder)
        await choice.chooseBackups({on: true, folder: null})
        expect(choice.backupDir()).toBe(join(dir, 'backup'))
        expect(existsSync(join(dir, 'data', 'orrery.db.backups.json'))).toBe(false)
    })

    it('turns them off, remembering the folder for when they\'re on again', async () => {
        const {dir, db, choice} = await setUp('backup')
        const folder = join(dir, 'elsewhere')
        await choice.chooseBackups({on: true, folder})
        await choice.chooseBackups({on: false, folder})
        expect(choice.backupDir()).toBe('')
        expect(db.describeDatabase()).toMatchObject({backups_off: true, backup_folder: folder})
        expect(db.describeDatabase().backup).toBeUndefined()
        vi.resetModules()
        expect((await import('../server/utils/backup-choice')).backupDir()).toBe('')
    })

    it('turns them on without NUXT_BACKUP_DIR only with a folder', async () => {
        const {dir, choice} = await setUp()
        expect(choice.backupDir()).toBe('')
        expect(await status(() => choice.chooseBackups({on: true}))).toBe(409)
        await choice.chooseBackups({on: true, folder: join(dir, 'mine')})
        expect(choice.backupDir()).toBe(join(dir, 'mine'))
    })

    it('refuses a folder that isn\'t one, isn\'t a full path, or holds the database, and keeps what it had', async () => {
        const {dir, choice} = await setUp('backup')
        writeFileSync(join(dir, 'a-file'), '')
        expect(await status(() => choice.chooseBackups({on: true, folder: join(dir, 'a-file')}))).toBe(400)
        expect(await status(() => choice.chooseBackups({on: true, folder: 'relative/folder'}))).toBe(400)
        expect(await status(() => choice.chooseBackups({on: true, folder: join(dir, 'data')}))).toBe(400)
        expect(await status(() => choice.chooseBackups({folder: join(dir, 'x')}))).toBe(400)
        expect(choice.backupDir()).toBe(join(dir, 'backup'))
    })
})

describe('who may set them', () => {
    /** backup-choice.ts loaded with the actor a request names, and a request to it by the name `host`, over a connection
     * from `from`. */
    async function guard(owner: boolean, host: string, database?: string, from = '127.0.0.1') {
        await setUp('backup')
        if (database) vi.stubGlobal('useRuntimeConfig', () => ({database, backupDir: ''}))
        vi.doMock('../server/utils/actor', () => ({actorOf: async () => ({name: owner ? 'skoll' : 'claude', owner})}))
        vi.resetModules()
        const fresh = await import('../server/utils/backup-choice')
        return () => fresh.maySetBackups({node: {req: {headers: {host}, socket: {remoteAddress: from}}}} as never)
    }

    it('is the owner, on the machine orrery runs on', async () => {
        for (const host of ['localhost:9010', '127.0.0.1:9010', 'orrery.localhost']) expect(await status(await guard(true, host))).toBe('ok')
    })

    it('is never an agent, nor anyone reaching it by another address', async () => {
        expect(await status(await guard(false, 'localhost:9010'))).toBe(403)
        for (const host of ['192.168.1.20:9010', 'mac.lan']) expect(await status(await guard(true, host))).toBe(403)
        // Nor by a connection from another machine that says it reached orrery as localhost.
        expect(await status(await guard(true, 'localhost:9010', undefined, '192.168.1.20'))).toBe(403)
    })

    it('is nobody while ORRERY_DATABASE names Postgres: its backups are set as it starts', async () => {
        expect(await status(await guard(true, 'localhost:9010', 'postgres://u:p@db:5432/o'))).toBe(409)
    })
})

describe.runIf(process.env.TEST_POSTGRES_URL)('backing up into Postgres', () => {
    /** A schema of its own in the test Postgres, by a URL that names it. */
    async function schema() {
        const name = `test_backup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        const admin = new pg.Client({connectionString: process.env.TEST_POSTGRES_URL})
        await admin.connect()
        await admin.query(`CREATE SCHEMA "${name}"`)
        const url = new URL(process.env.TEST_POSTGRES_URL!)
        url.searchParams.set('options', `-c search_path=${name}`)
        return {url: url.toString(), drop: async () => {
            await admin.query(`DROP SCHEMA "${name}" CASCADE`)
            await admin.end()
        }}
    }
    const projectsIn = async (url: string) => {
        const client = new pg.Client({connectionString: url})
        await client.connect()
        try {
            return (await client.query<{id: string}>('SELECT id FROM projects ORDER BY id')).rows.map(r => r.id)
        } finally {
            await client.end()
        }
    }

    it('copies into an empty one at once, marked as this orrery\'s backup, and the latest takes its place', async () => {
        const {db, choice} = await setUp()
        const {url, drop} = await schema()
        try {
            await choice.chooseBackups({on: true, postgres: url})
            expect(await projectsIn(url)).toEqual(['greenhouse'])
            const shown = db.describeDatabase()
            expect(shown).toMatchObject({backup_kind: 'postgres', backed_up_at: expect.any(String)})
            if (new URL(url).password) expect(JSON.stringify(shown)).not.toContain(`:${new URL(url).password}@`)
            await new Store(db.useDatabase()).createProject({name: 'Pantry', key: 'PAN'}, {name: 'skoll', owner: true})
            const {backUpTo} = await import('../server/utils/backup')
            await backUpTo(db.useDatabase(), choice.backupTarget()!)
            expect(await projectsIn(url)).toEqual(['greenhouse', 'pantry'])
            // Turned off and on again with no URL (the page doesn't have its password), it goes on into the same one.
            await choice.chooseBackups({on: false})
            expect(choice.backupTarget()).toBeNull()
            expect(db.describeDatabase()).toMatchObject({backups_off: true, backup_postgres: expect.any(String)})
            await choice.chooseBackups({on: true})
            expect(choice.backupTarget()).toEqual({kind: 'postgres', url})
        } finally {
            const {closeBackupDb} = await import('../server/utils/backup')
            await closeBackupDb()
            await db.closeDb()
            await drop()
        }
    })

    it("won't write over an orrery that isn't this one's backup, and keeps the choice it had", async () => {
        const {db, choice} = await setUp()
        const {url, drop} = await schema()
        try {
            const other = new PostgresDb(url)
            await new Store(other).createProject({name: 'Cellar', key: 'CEL'}, {name: 'skoll', owner: true})
            await other.close()
            await expect(choice.chooseBackups({on: true, postgres: url})).rejects.toMatchObject({statusCode: 400, message: expect.stringContaining("isn't this one's backup")})
            expect(await projectsIn(url)).toEqual(['cellar'])
            expect(choice.backupTarget()).toBeNull()
        } finally {
            const {closeBackupDb} = await import('../server/utils/backup')
            await closeBackupDb()
            await db.closeDb()
            await drop()
        }
    })
})
