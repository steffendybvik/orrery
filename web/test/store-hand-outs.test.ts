// Handing work only to the agents of the person it's assigned to (ORR-656): what the store stamps on what it sends, which
// the stream checks at the receiver. The Todo hand-out, unblocking, picking and carrying on are in their own tests.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Signal} from '#shared/roadmap'
import type {Actor} from '../server/utils/store'
import {Store} from '../server/utils/store'
import {testDb} from './db'
import {failure} from './store-setup'

let store: Store
let signals: Signal[]
const owner: Actor = {name: 'skoll', owner: true}
const asked: Actor = {...owner, asked: true}
const sessions: Record<string, string> = {'hati-a': 'hati', 'skoll-a': 'skoll'}

beforeEach(async () => {
    signals = []
    store = new Store(testDb(), () => {}, signal => signals.push(signal))
    store.sessionPerson = session => sessions[session]
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.nameOwner({name: 'Skoll'})
    await store.addPerson({name: 'Hati'})
    await store.addMember('greenhouse', {person: 'hati'}, owner)
})

const add = async (body: Record<string, unknown> = {}) => (await store.createIssue('greenhouse', {title: 'Seed trays', ...body}, owner)).id
const last = () => signals.at(-1) as Signal

describe('whose work an issue is', () => {
    it('is nothing to say with one person', async () => {
        const solo = new Store(testDb(), () => {})
        await solo.createProject({name: 'cellar', key: 'CEL'})
        await solo.nameOwner({name: 'Skoll'})
        for (const assignee of [null, 'skoll', 'claude']) expect(await solo.whoseWork('cellar', assignee)).toBeUndefined()
    })

    it('is its assignee\'s, with `claude` the owner\'s', async () => {
        expect(await store.whoseWork('greenhouse', 'hati')).toBe('hati')
        expect(await store.whoseWork('greenhouse', 'claude')).toBe('skoll')
    })

    it('is nobody\'s when it\'s unassigned on a board with more, and the only person\'s on a board with one', async () => {
        await store.createProject({name: 'attic', key: 'ATT'}, owner, 'hati')
        expect(await store.whoseWork('greenhouse', null)).toBeNull()
        expect(await store.whoseWork('greenhouse', 'somebody')).toBeNull()
        expect(await store.whoseWork('attic', null)).toBe('hati')
    })
})

describe('what goes out', () => {
    it('as the owner\'s focus goes to the assignee\'s sessions, past the session on it if that\'s someone else\'s', async () => {
        const id = await add({assignee: 'hati'})
        await store.workedBy('greenhouse', id, 'skoll-a')
        await store.focus('greenhouse', id, {}, owner)
        expect(last()).toMatchObject({person: 'hati', protected: true, target: undefined})
    })

    it('as the owner pointing at someone else\'s issue takes it over, for their own', async () => {
        const id = await add({assignee: 'hati'})
        await store.focus('greenhouse', id, {}, asked)
        expect((await store.issue('greenhouse', id)).assignee).toBe('skoll')
        expect(last()).toMatchObject({person: 'skoll', protected: true})
    })

    it('can\'t be aimed at a session that isn\'t the issue\'s person\'s', async () => {
        const id = await add({assignee: 'hati'})
        expect((await failure(() => store.focus('greenhouse', id, {session: 'skoll-a'}, owner))).status).toBe(409)
        await store.focus('greenhouse', id, {session: 'hati-a'}, owner)
        expect(last()).toMatchObject({target: 'hati-a', person: 'hati'})
    })

    it('as a P0 goes to the assignee\'s, and on what\'s nobody\'s, to no one', async () => {
        const hatis = await add({assignee: 'hati', status: 'todo'})
        const before = signals.length
        const nobodys = await add({status: 'todo'})
        await store.updateIssue('greenhouse', nobodys, {priority: 'P0'}, owner)
        expect(signals).toHaveLength(before)
        await store.updateIssue('greenhouse', hatis, {priority: 'P0'}, owner)
        expect(last()).toMatchObject({person: 'hati', protected: true, note: 'It was just made urgent (P0).'})
    })

    it('as a pull request\'s news goes to the assignee\'s, and on what\'s nobody\'s, to no one', async () => {
        const hatis = await add({assignee: 'hati'})
        await store.systemComment('greenhouse', hatis, 'It merged', 'pr.merged')
        expect(last()).toMatchObject({kind: 'comment', person: 'hati', protected: true})
        const before = signals.length
        await store.systemComment('greenhouse', await add(), 'It merged', 'pr.merged')
        expect(signals).toHaveLength(before)
    })

    it('as the owner\'s comment goes to the assignee\'s, and on what\'s nobody\'s, to their own', async () => {
        await store.createComment('greenhouse', await add({assignee: 'hati'}), {body: 'Stop that'}, owner)
        expect(last()).toMatchObject({person: 'hati', protected: true})
        await store.createComment('greenhouse', await add(), {body: 'Someone take this'}, owner)
        expect(last()).toMatchObject({person: 'skoll', protected: true})
    })

    it('as a catch-up reaches only the person whose issue it\'s on', async () => {
        const id = await add({assignee: 'hati'})
        await store.workedBy('greenhouse', id, 'hati-a')
        await store.createComment('greenhouse', id, {body: 'Stop that'}, owner)
        expect(await store.carryUnanswered('greenhouse', 'skoll-a', 'skoll')).toBe(0)
        expect(await store.carryUnanswered('greenhouse', 'hati-b', 'hati')).toBe(1)
        expect(last()).toMatchObject({target: 'hati-b', person: 'hati', protected: true})
    })
})

describe('with one person', () => {
    it('stamps no one, so every session hears as it did', async () => {
        const solo = new Store(testDb(), () => {}, signal => signals.push(signal))
        await solo.createProject({name: 'cellar', key: 'CEL'})
        await solo.nameOwner({name: 'Skoll'})
        const {id} = await solo.createIssue('cellar', {title: 'Racks', status: 'todo'}, owner)
        await solo.focus('cellar', id, {}, owner)
        expect(last().person).toBeUndefined()
        await solo.createComment('cellar', id, {body: 'Hello'}, owner)
        expect(last().person).toBeUndefined()
        await solo.updateIssue('cellar', id, {priority: 'P0'}, owner)
        expect(last().person).toBeUndefined()
    })
})
