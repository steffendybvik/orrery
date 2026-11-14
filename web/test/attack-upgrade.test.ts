import {describe, expect, it} from 'vitest'
import {copyDatabase} from '../server/utils/copy'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import type {Actor} from '../server/utils/store'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// People, members, claims and keys going where the database goes (ORR-659): a copy (`pnpm orrery:copy`). The upgrade
// with data in it, on both databases, is in schema-parity.test.ts.
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
    it('go along in a copy', async () => {
        const from = new Store(new SqliteDb(openDb(':memory:')))
        const made = await peopled(from)
        const into = new Store(testDb())
        await copyDatabase(from.db, into.db)
        await itCameThrough(into, made)
    })
})
