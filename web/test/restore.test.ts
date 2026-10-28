import {existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {beforeEach, describe, expect, it} from 'vitest'
import {backUp} from '../server/utils/backup'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {isFresh, keepBeforeRestore, listSnapshots, noteEnvironment, restoredCopy} from '../server/utils/restore'
import {Store} from '../server/utils/store'

// Restoring from a backup only when the owner picks one (ORR-448): the copies listed with whose they are, a new
// orrery told apart from one in use, and the copy restored checked first, beside the database, under a name of its own.
let dir: string
let backups: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orrery-restore-'))
    backups = join(dir, 'backups')
})

/** An orrery in a file of its own, under the name `environment`, with a project if `project`. */
async function orrery(name: string, environment: string, project = true) {
    const store = new Store(new SqliteDb(openDb(join(dir, name))))
    await store.settings()
    await noteEnvironment(store.db, environment)
    if (project) await store.createProject({name: 'greenhouse', key: 'GRE', release_mode: 'own'})
    return store
}

describe('the backups', () => {
    it('are listed newest first, with their kind and whose they are', async () => {
        const store = await orrery('orrery.db', 'work')
        await backUp(store.db, backups)
        writeFileSync(join(backups, 'notes.txt'), 'not a backup')
        const found = listSnapshots(backups)
        expect(found.map(s => s.kind).sort()).toEqual(['daily', 'latest'])
        const {id} = await store.settings()
        expect(found[0]).toMatchObject({of: id, environment: 'work', projects: 1, size: expect.any(Number), at: expect.any(String)})
        expect(listSnapshots(join(dir, 'none'))).toEqual([])
    })

    it('hold up the writes only while the copy is made, not while it is checked and kept (ORR-483)', async () => {
        const store = await orrery('orrery.db', 'work')
        let backedUp = false
        const backing = backUp(store.db, backups).then(() => {
            backedUp = true
        })
        await store.createProject({name: 'mesa', key: 'MES', release_mode: 'own'})
        expect(backedUp).toBe(false)
        await backing
        expect(listSnapshots(backups).find(s => s.kind === 'latest')).toMatchObject({projects: 1})
    })

    it('read each copy again only once it has changed (ORR-483)', async () => {
        const store = await orrery('orrery.db', 'work')
        await backUp(store.db, backups)
        expect(listSnapshots(backups).find(s => s.kind === 'latest')).toMatchObject({projects: 1})
        await store.createProject({name: 'mesa', key: 'MES', release_mode: 'own'})
        await backUp(store.db, backups)
        expect(listSnapshots(backups).find(s => s.kind === 'latest')).toMatchObject({projects: 2})
    })

    it('tell a new orrery from one in use', async () => {
        const store = await orrery('fresh.db', 'personal', false)
        expect(await isFresh(store.db)).toBe(true)
        await store.createProject({name: 'greenhouse', key: 'GRE', release_mode: 'own'})
        expect(await isFresh(store.db)).toBe(false)
    })
})

describe('a restore', () => {
    it('copies the chosen backup beside the database, checked, under a name of its own', async () => {
        const store = await orrery('orrery.db', 'personal')
        await backUp(store.db, backups)
        const copy = restoredCopy(backups, 'orrery.db', join(dir, 'live', 'orrery.db'))
        expect(copy).toMatch(/live\/orrery-restored-[\dT-]+\.db$/)
        expect(await new Store(new SqliteDb(openDb(copy))).listProjects()).toHaveLength(1)
    })

    it('refuses a file that is not a backup, and a damaged one', () => {
        mkdirSync(backups, {recursive: true})
        expect(() => restoredCopy(backups, '../orrery.db', join(dir, 'orrery.db'))).toThrow("isn't one of the backups")
        expect(() => restoredCopy(backups, 'orrery-2026-01-01.db', join(dir, 'orrery.db'))).toThrow("isn't in")
        writeFileSync(join(backups, 'orrery.db'), 'cut short')
        expect(() => restoredCopy(backups, 'orrery.db', join(dir, 'orrery.db'))).toThrow('the copy is damaged')
    })

    it('keeps the database as it was in the backup folder first', async () => {
        const store = await orrery('orrery.db', 'personal')
        mkdirSync(backups, {recursive: true})
        const kept = await keepBeforeRestore(store.db, backups)
        expect(kept).toMatch(/^orrery-pre-restore-.+\.db$/)
        expect(existsSync(join(backups, kept))).toBe(true)
        expect(listSnapshots(backups).find(s => s.name === kept)).toMatchObject({kind: 'before', projects: 1})
    })
})

describe('a backup over another orrery', () => {
    it("sets that one's latest aside rather than writing over it", async () => {
        const before = await orrery('before.db', 'personal')
        await backUp(before.db, backups)
        const fresh = await orrery('fresh.db', 'personal', false)
        await backUp(fresh.db, backups)
        const found = listSnapshots(backups)
        expect(found.find(s => s.kind === 'latest')).toMatchObject({of: (await fresh.settings()).id, projects: 0})
        expect(found.find(s => /^orrery-pre-other-/.test(s.name))).toMatchObject({of: (await before.settings()).id, projects: 1})
    })
})
