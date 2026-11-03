import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {backUp} from '../server/utils/backup'
import {copyDatabase} from '../server/utils/copy'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {restoredCopy} from '../server/utils/restore'
import type {Actor} from '../server/utils/store'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// People, members, claims and keys going where the database goes (ORR-659): a copy, a move (which is a copy), a backup
// and a restore, and back from the copy made before an upgrade. The upgrade with data in it, on both databases, is in
// schema-parity.test.ts.
const owner: Actor = {name: 'skoll', owner: true, asked: true}
const hatis: Actor = {name: 'claude', owner: false, asked: true, session: 'hati-a', named: 'hati'}

/** Two people on a shared board, with a claim, and a key for each. */
async function peopled(store: Store) {
    await store.nameOwner({name: 'Skoll'})
    await store.addPerson({name: 'Hati'})
    await store.createProject({name: 'greenhouse', key: 'GRE'}, owner)
    await store.addMember('greenhouse', {person: 'hati'}, owner)
    const {id} = await store.createIssue('greenhouse', {title: 'Seed trays', assignee: 'hati'}, owner)
    await store.updateIssue('greenhouse', id, {status: 'in-progress'}, hatis)
    const {key} = await store.makeKey('hati', {kind: 'agent', name: 'laptop'})
    return {id, key}
}

/** That it all came through, and the rails still hold on it. */
async function itCameThrough(store: Store, {id, key}: {id: string, key: string}) {
    expect((await store.people()).map(p => p.id)).toEqual(['skoll', 'hati'])
    expect((await store.members('greenhouse')).map(m => m.person).sort()).toEqual(['hati', 'skoll'])
    expect(await store.issue('greenhouse', id)).toMatchObject({assignee: 'hati', claimed_by: 'hati'})
    expect(await store.keyHolder(key)).toMatchObject({person: 'hati'})
    await expect(store.updateIssue('greenhouse', id, {title: 'Mine'}, {...hatis, named: 'skoll'})).rejects.toMatchObject({statusCode: 409})
}

describe('people, members, claims and keys', () => {
    it('go along in a copy, and so in a move', async () => {
        const from = new Store(new SqliteDb(openDb(':memory:')))
        const made = await peopled(from)
        const into = new Store(testDb())
        await copyDatabase(from.db, into.db)
        await itCameThrough(into, made)
    })

    it('go along in a backup, and come back in a restore', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-attack-'))
        const store = new Store(new SqliteDb(openDb(join(dir, 'orrery.db'))))
        const made = await peopled(store)
        const backups = join(dir, 'backups')
        await backUp(store.db, backups)
        const restored = restoredCopy(backups, 'orrery.db', join(dir, 'live', 'orrery.db'))
        await itCameThrough(new Store(new SqliteDb(openDb(restored))), made)
    })
})

describe.runIf(process.env.TEST_POSTGRES_URL)('on Postgres, people, members, claims and keys', () => {
    it("go along in a backup, a SQLite snapshot, and a new orrery starts from it (ORR-733)", async () => {
        const store = new Store(testDb())
        const made = await peopled(store)
        const dir = mkdtempSync(join(tmpdir(), 'orrery-attack-'))
        const backups = join(dir, 'backups')
        await backUp(store.db, backups)
        const restored = restoredCopy(backups, 'orrery.db', join(dir, 'live', 'orrery.db'))
        await itCameThrough(new Store(new SqliteDb(openDb(restored))), made)
    })
})

describe('going back', () => {
    it('works from the copy made before the upgrade: an older orrery\'s file, as it was, opening at its own step', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-attack-'))
        const path = join(dir, 'orrery.db')
        const old = openDb(path, 62)
        old.exec(`INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x');`)
        old.close()
        openDb(path, undefined, join(dir, 'orrery-pre-upgrade.db')).close()
        const before = openDb(join(dir, 'orrery-pre-upgrade-step62.db'), 62)
        expect(before.prepare('PRAGMA user_version').get()).toEqual({user_version: 62})
        expect(before.prepare('SELECT id FROM projects').all()).toEqual([{id: 'greenhouse'}])
        expect(before.prepare(`SELECT name FROM sqlite_master WHERE name = 'project_members'`).all()).toEqual([])
        before.close()
    })
})
