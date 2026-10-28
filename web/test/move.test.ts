import {existsSync, mkdtempSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {beforeEach, describe, expect, it, vi} from 'vitest'
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
    await store.createProject({name: 'Larder', key: 'LAR'}, {name: 'skoll', owner: true})
    await store.createIssue('larder', {title: 'Shelf labels'})
    return {dir, db, move, store}
}

const rebound: Db[] = []
const rebind = (db: Db) => void rebound.push(db)

beforeEach(() => {
    rebound.length = 0
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

    it('tells an empty database from an Orrery\'s, the one it runs on, and something else\'s', async () => {
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
        expect((await new Store(db.useDatabase()).listBoards()).map(p => p.id)).toEqual(['larder'])

        // A fresh start reads where it went.
        vi.resetModules()
        const restarted = await import('../server/utils/db')
        expect(restarted.databaseSetting()).toBe(target)
        await restarted.closeDb()
    })

    it('runs on an Orrery\'s own as it is, won\'t copy over it, and going back to its own file forgets the move', async () => {
        const {dir, db, move} = await setUp()
        const target = join(dir, 'orrery-2.db')
        await move.moveDatabase(target, 'copy', rebind)
        const original = join(dir, 'orrery.db')
        await expect(move.moveDatabase(original, 'copy', rebind)).rejects.toThrow(/an Orrery's already, with 1 project/)
        await expect(move.moveDatabase(target, 'use', rebind)).rejects.toThrow(/already runs on/)
        await move.moveDatabase(original, 'use', rebind)
        expect(db.databaseSetting()).toBe(original)
        expect(existsSync(join(dir, 'orrery.db.moved.json'))).toBe(false)
        expect(db.describeDatabase().moved).toBeUndefined()
        await db.closeDb()
    })

    it('won\'t run as it is on one that isn\'t an Orrery\'s', async () => {
        const {dir, move} = await setUp()
        await expect(move.moveDatabase(join(dir, 'new.db'), 'use', rebind)).rejects.toThrow(/isn't an Orrery's yet/)
        expect(rebound).toHaveLength(0)
    })
})
