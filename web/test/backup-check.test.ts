import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {beforeEach, describe, expect, it} from 'vitest'
import {backUpTo, checkSnapshot, lastBackupFailure, putInPlace} from '../server/utils/backup'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {Store} from '../server/utils/store'

// Backups that are checked before they're kept (ORR-448): a snapshot that fails SQLite's check never takes the place of
// the one before, the copy before an upgrade is written whole or not at all, and the last failure is kept to show.
let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orrery-backup-check-'))
})

/** A SQLite file with one project in it. */
async function made(path: string) {
    const store = new Store(new SqliteDb(openDb(path)))
    await store.createProject({name: 'greenhouse', key: 'GRE', release_mode: 'own'})
    return store
}

describe('snapshots', () => {
    it('pass a sound copy, and refuse a damaged one', async () => {
        const good = join(dir, 'good.db')
        ;(await made(good)).db.close?.()
        expect(() => checkSnapshot(good)).not.toThrow()
        expect(() => checkSnapshot(good, true)).not.toThrow()
        const bad = join(dir, 'bad.db')
        writeFileSync(bad, 'not a database at all, just bytes')
        expect(() => checkSnapshot(bad)).toThrow('the copy is damaged')
    })

    it('keep the one before when a new one fails its check, and let the new one go', () => {
        const latest = join(dir, 'orrery.db')
        new DatabaseSync(latest).close()
        const before = readFileSync(latest)
        const partial = join(dir, '.orrery.db.partial')
        writeFileSync(partial, 'cut short')
        expect(() => putInPlace(partial, latest)).toThrow('kept the one before')
        expect(existsSync(partial)).toBe(false)
        expect(readFileSync(latest)).toEqual(before)
    })
})

describe('a failed backup', () => {
    it('is kept to show until one to the same place works', async () => {
        const store = await made(join(dir, 'orrery.db'))
        // A file where the folder should be: nothing can be written there.
        const blocked = join(dir, 'blocked')
        writeFileSync(blocked, '')
        const target = {kind: 'folder' as const, dir: join(blocked, 'backups')}
        await expect(backUpTo(store.db, target)).rejects.toThrow()
        expect(lastBackupFailure(target)).toMatchObject({message: expect.any(String), at: expect.any(String)})
        // Another place doesn't say it failed.
        const elsewhere = {kind: 'folder' as const, dir: join(dir, 'backups')}
        expect(lastBackupFailure(elsewhere)).toBeUndefined()
        await backUpTo(store.db, elsewhere)
        expect(existsSync(join(dir, 'backups', 'orrery.db'))).toBe(true)
        expect(lastBackupFailure(elsewhere)).toBeUndefined()
    })
})

describe('the copy before an upgrade', () => {
    it('stops the upgrade with a clear reason when it cannot be made, leaving the database as it was', () => {
        const path = join(dir, 'orrery.db')
        openDb(path, 40).close()
        writeFileSync(join(dir, 'blocked'), '')
        const snapshot = join(dir, 'blocked', 'orrery-pre-1.0.0.db')
        expect(() => openDb(path, undefined, snapshot)).toThrow(/won't upgrade .* without a copy of it as it is/)
        const raw = new DatabaseSync(path)
        expect((raw.prepare('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(40)
        raw.close()
    })

    it('is written whole, with nothing left beside it', () => {
        const path = join(dir, 'orrery.db')
        openDb(path, 40).close()
        const snapshot = join(dir, 'backup', 'orrery-pre-1.0.0-step40.db')
        openDb(path, undefined, join(dir, 'backup', 'orrery-pre-1.0.0.db')).close()
        expect(() => checkSnapshot(snapshot, true)).not.toThrow()
        expect(existsSync(`${snapshot}.partial`)).toBe(false)
    })
})
