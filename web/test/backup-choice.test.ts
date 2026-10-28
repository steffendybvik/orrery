import {existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {backupDelay} from '../server/utils/backup'
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

describe('how often, and how many daily copies', () => {
    it('backs up after each change and keeps two weeks until the owner chooses otherwise', async () => {
        const {choice, db} = await setUp('backup')
        expect([choice.backupEvery(), choice.backupKeep()]).toEqual(['change', 14])
        expect(db.describeDatabase()).toMatchObject({backup_every: 'change', backup_keep: 14})
    })

    it('keeps the owner\'s choice for the next start, whatever turns them on or off, and forgets it back at the defaults', async () => {
        const {dir, db, choice} = await setUp('backup')
        await choice.chooseBackups({every: 'hour', keep: 5})
        expect(db.describeDatabase()).toMatchObject({backup: join(dir, 'backup'), backup_every: 'hour', backup_keep: 5})
        await choice.chooseBackups({on: false})
        await choice.chooseBackups({on: true})
        vi.resetModules()
        const fresh = await import('../server/utils/backup-choice')
        expect([fresh.backupDir(), fresh.backupEvery(), fresh.backupKeep()]).toEqual([join(dir, 'backup'), 'hour', 5])
        await fresh.chooseBackups({every: 'change', keep: 14})
        expect(existsSync(join(dir, 'data', 'orrery.db.backups.json'))).toBe(false)
    })

    it('refuses what isn\'t one of them, and keeps what it had', async () => {
        const {choice} = await setUp('backup')
        await choice.chooseBackups({every: 'day'})
        for (const body of [{every: 'weekly'}, {keep: 0}, {keep: 2.5}, {keep: 366}, {keep: '7'}, {}]) expect(await status(() => choice.chooseBackups(body))).toBe(400)
        expect([choice.backupEvery(), choice.backupKeep()]).toEqual(['day', 14])
    })

    it('keeps that many daily copies, and the three newest taken before an upgrade', async () => {
        const {dir, choice} = await setUp('backup')
        const folder = join(dir, 'backup')
        mkdirSync(folder)
        for (let day = 1; day <= 9; day++) writeFileSync(join(folder, `orrery-2026-01-0${day}.db`), '')
        for (const [i, version] of ['1.0.0-rc.7', '1.0.0-rc.8', '1.0.0-rc.9', '1.0.0-rc.10'].entries()) {
            writeFileSync(join(folder, `orrery-pre-${version}.db`), '')
            utimesSync(join(folder, `orrery-pre-${version}.db`), 1_000_000 + i, 1_000_000 + i)
        }
        await choice.chooseBackups({on: true, keep: 3})
        const left = readdirSync(folder).sort()
        expect(left.filter(name => /^orrery-\d/.test(name))).toEqual(['orrery-2026-01-08.db', 'orrery-2026-01-09.db', `orrery-${new Date().toISOString().slice(0, 10)}.db`])
        expect(left.filter(name => name.startsWith('orrery-pre-'))).toEqual(['orrery-pre-1.0.0-rc.10.db', 'orrery-pre-1.0.0-rc.8.db', 'orrery-pre-1.0.0-rc.9.db'])
    })

    it('waits a few seconds after a change, or until the interval since the last backup has gone', () => {
        const settle = 3000
        const minute = 60_000
        // After each change: the settle, put off by more changes, but never past ten settles from the first.
        expect(backupDelay('change', settle, 0, 0, -minute)).toBe(3000)
        expect(backupDelay('change', settle, 29_000, 0, -minute)).toBe(1000)
        expect(backupDelay('change', settle, 40_000, 0, -minute)).toBe(0)
        // On an interval: what's left of it since the last backup, and at least the settle.
        expect(backupDelay('15m', settle, 5 * minute, 5 * minute, 0)).toBe(10 * minute)
        expect(backupDelay('hour', settle, 90 * minute, 90 * minute, 0)).toBe(3000)
        expect(backupDelay('day', settle, minute, minute, 0)).toBe(24 * 60 * minute - minute)
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

    it('is the owner, on the machine Orrery runs on', async () => {
        for (const host of ['localhost:9010', '127.0.0.1:9010', 'orrery.localhost']) expect(await status(await guard(true, host))).toBe('ok')
    })

    it('is never an agent, nor anyone reaching it by another address', async () => {
        expect(await status(await guard(false, 'localhost:9010'))).toBe(403)
        for (const host of ['192.168.1.20:9010', 'mac.lan']) expect(await status(await guard(true, host))).toBe(403)
        // Nor by a connection from another machine that says it reached Orrery as localhost.
        expect(await status(await guard(true, 'localhost:9010', undefined, '192.168.1.20'))).toBe(403)
    })

    it('is nobody while ORRERY_DATABASE names Postgres: its backups are set as it starts', async () => {
        expect(await status(await guard(true, 'localhost:9010', 'postgres://u:p@db:5432/o'))).toBe(409)
    })
})
