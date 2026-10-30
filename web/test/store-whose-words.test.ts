// Whose words reach whom (ORR-658): a member is neither the owner nor an agent. Their words go to their own sessions and
// no one else's, the owner's to everyone's as they always have, and each person's bell is their own.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {PERMISSIONS} from '#shared/permissions'
import type {Actor} from '../server/utils/store'
import {Store} from '../server/utils/store'
import {testDb} from './db'
import {failure} from './store-setup'

let store: Store
let signals: Signal[]
const owner: Actor = {name: 'skoll', owner: true, asked: true}
const hati: Actor = {name: 'hati', owner: false, asked: true, person: 'hati'}
const manni: Actor = {name: 'manni', owner: false, asked: true, person: 'manni'}
const agentOf = (named: string, session = 'other'): Actor => ({name: 'claude', owner: false, asked: true, named, session})
const sessions: Record<string, string> = {'hati-a': 'hati', 'hati-b': 'hati', 'skoll-a': 'skoll'}

beforeEach(async () => {
    signals = []
    store = new Store(testDb(), () => {}, signal => signals.push(signal))
    store.sessionPerson = session => sessions[session]
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.nameOwner({name: 'Skoll'})
    for (const name of ['Hati', 'Manni']) {
        await store.addPerson({name})
        await store.addMember('greenhouse', {person: name.toLowerCase()}, owner)
    }
})

const add = async (body: Record<string, unknown> = {}) => (await store.createIssue('greenhouse', {title: 'Seed trays', ...body}, owner)).id
const lastSignal = () => signals.at(-1) as Signal

describe('a comment', () => {
    it('from a member goes to the session on it when that one is theirs, as theirs and not as the owner\'s', async () => {
        const id = await add({assignee: 'hati'})
        await store.workedBy('greenhouse', id, 'hati-a')
        await store.createComment('greenhouse', id, {body: 'Use the blue ones'}, hati)
        expect(lastSignal()).toMatchObject({kind: 'comment', target: 'hati-a', person: 'hati', protected: false, created_by: 'hati'})
    })

    it('from a member goes to one of theirs when nobody\'s on their issue', async () => {
        const id = await add({assignee: 'hati'})
        await store.createComment('greenhouse', id, {body: 'Use the blue ones'}, hati)
        expect(lastSignal()).toMatchObject({target: undefined, person: 'hati', protected: false})
    })

    it('from a member never goes to another person\'s session, or wakes anyone on someone else\'s issue', async () => {
        const id = await add({assignee: 'skoll'})
        await store.workedBy('greenhouse', id, 'skoll-a')
        const before = signals.length
        await store.createComment('greenhouse', id, {body: 'Looks wrong to me'}, hati)
        expect(signals).toHaveLength(before)
    })

    it('from the owner still goes to the session on it, whoever\'s it is', async () => {
        const id = await add({assignee: 'hati'})
        await store.workedBy('greenhouse', id, 'hati-a')
        await store.createComment('greenhouse', id, {body: 'Stop that'}, owner)
        expect(lastSignal()).toMatchObject({target: 'hati-a', protected: true})
        expect(lastSignal().person).toBeUndefined()
    })

    it('from an agent wakes nobody, and is kept with its person', async () => {
        const id = await add({assignee: 'hati'})
        const before = signals.length
        await store.createComment('greenhouse', id, {body: 'Done'}, agentOf('hati'))
        expect(signals).toHaveLength(before)
        expect(await store.get<{person: string, by_agent: number}>('SELECT person, by_agent FROM comments')).toMatchObject({person: 'hati', by_agent: 1})
    })

    it('from a member can\'t be reworded or deleted by anyone else but the owner', async () => {
        const id = await add({assignee: 'hati'})
        const comment = await store.createComment('greenhouse', id, {body: 'Mine'}, hati)
        for (const actor of [manni, agentOf('hati')]) {
            expect((await failure(() => store.updateComment('greenhouse', id, comment.id, {body: 'Theirs'}, actor))).status).toBe(403)
            expect((await failure(() => store.deleteComment('greenhouse', id, comment.id, actor))).status).toBe(403)
        }
        const edits = signals.length
        await store.updateComment('greenhouse', id, comment.id, {body: 'Still mine'}, hati)
        expect(signals).toHaveLength(edits + 1)
        expect(lastSignal()).toMatchObject({person: 'hati', protected: false})
        await store.deleteComment('greenhouse', id, comment.id, owner)
    })

    it('catches a member\'s session up on their own words, and not another member\'s', async () => {
        const id = await add({assignee: 'hati'})
        await store.workedBy('greenhouse', id, 'hati-b')
        await store.createComment('greenhouse', id, {body: 'Use the blue ones'}, hati)
        expect(await store.carryUnanswered('greenhouse', 'manni-a', 'manni')).toBe(0)
        expect(await store.carryUnanswered('greenhouse', 'hati-a', 'hati')).toBe(1)
        expect(lastSignal()).toMatchObject({target: 'hati-a', person: 'hati', protected: false})
    })

    it('from a member answers their agent\'s question, leaving the issue theirs', async () => {
        const id = await add({assignee: 'hati'})
        await store.createComment('greenhouse', id, {body: 'Which?', asks: 'decision'}, agentOf('hati'))
        expect((await store.issue('greenhouse', id)).assignee).toBe('hati')
        expect((await store.issue('greenhouse', id)).waiting).toBe('decision')
        await store.createComment('greenhouse', id, {body: 'The blue ones'}, hati)
        const issue = await store.issue('greenhouse', id)
        expect(issue.waiting).toBeUndefined()
        expect(issue.assignee).toBe('hati')
    })
})

describe('a focus', () => {
    it('from a member is theirs, and goes only to their own', async () => {
        const id = await add({assignee: 'hati'})
        await store.workedBy('greenhouse', id, 'skoll-a')
        await store.focus('greenhouse', id, {}, hati)
        expect(lastSignal()).toMatchObject({kind: 'focus', target: undefined, person: 'hati', protected: false})
        await store.focus('greenhouse', id, {session: 'hati-b'}, hati)
        expect(lastSignal()).toMatchObject({target: 'hati-b', person: 'hati'})
    })

    it('from a member, naming someone else\'s session, is refused', async () => {
        const id = await add({assignee: 'hati'})
        const {status, message} = await failure(() => store.focus('greenhouse', id, {session: 'skoll-a'}, hati))
        expect(status).toBe(409)
        expect(message).toContain("isn't hati's")
    })

    it('on a chunk from a member is theirs too', async () => {
        await store.createChunk('greenhouse', {title: 'Joints'}, owner)
        await store.focusChunk('greenhouse', 'all', {}, hati)
        expect(lastSignal()).toMatchObject({person: 'hati', protected: false})
    })

    it('waits for a member\'s session as the owner\'s do', async () => {
        const id = await add({assignee: 'hati'})
        await store.focus('greenhouse', id, {}, hati)
        expect(await store.pooledWaiting('greenhouse')).toMatchObject([{person: 'hati'}])
        expect(await store.focusOnItsWay('greenhouse', id)).toBe(true)
    })
})

describe('a P0', () => {
    it('set by a member pushes to their own sessions', async () => {
        const id = await add({assignee: 'hati', status: 'todo'})
        await store.updateIssue('greenhouse', id, {priority: 'P0'}, hati)
        expect(lastSignal()).toMatchObject({kind: 'focus', person: 'hati', protected: false, note: 'It was just made urgent (P0).'})
    })

    it('set by an agent pushes to nobody', async () => {
        const id = await add({assignee: 'hati', status: 'todo'})
        const before = signals.length
        await store.updateIssue('greenhouse', id, {priority: 'P0'}, agentOf('hati'))
        expect(signals).toHaveLength(before)
    })
})

describe('what happened', () => {
    it('says a member did it, who is neither the owner nor an agent', async () => {
        const heard: {by?: {person?: string, owner: boolean}}[] = []
        store.happened = event => heard.push(event)
        const id = await add({assignee: 'hati'})
        await store.updateIssue('greenhouse', id, {status: 'in-progress'}, hati)
        expect(heard.at(-1)?.by).toEqual({name: 'hati', owner: false, person: 'hati'})
        await store.updateIssue('greenhouse', id, {status: 'todo'}, owner)
        expect(heard.at(-1)?.by).toEqual({name: 'skoll', owner: true})
    })
})

describe('the bell', () => {
    const bell = async (person?: string, list?: 'bell' | 'waiting' | 'inbox' | 'cleared') => (await store.notices({person, list})).map(n => n.body)

    it('shows a person their agents\' words and what others say on what\'s theirs', async () => {
        const hatis = await add({assignee: 'hati'})
        const skolls = await add({assignee: 'skoll'})
        await store.createComment('greenhouse', hatis, {body: 'By Hati\'s agent'}, agentOf('hati'))
        await store.createComment('greenhouse', skolls, {body: 'By Skoll\'s agent'}, agentOf('skoll'))
        await store.createComment('greenhouse', hatis, {body: 'By Hati'}, hati)
        await store.createComment('greenhouse', hatis, {body: 'By Manni'}, manni)
        await store.createComment('greenhouse', hatis, {body: 'By Skoll'}, owner)
        expect((await bell('hati')).sort()).toEqual(['By Hati\'s agent', 'By Manni', 'By Skoll'])
        expect(await bell('skoll')).toEqual(['By Skoll\'s agent'])
        expect(await bell('manni')).toEqual([])
    })

    it('puts an agent\'s question to its person, not the owner', async () => {
        const id = await add({assignee: 'hati'})
        await store.createComment('greenhouse', id, {body: 'Which?', asks: 'decision'}, agentOf('hati'))
        expect(await bell('hati', 'waiting')).toEqual(['Which?'])
        expect(await bell('skoll', 'waiting')).toEqual([])
    })

    it('keeps what orrery says for the owner, and for whoever\'s issue it is', async () => {
        const id = await add({assignee: 'hati'})
        await store.systemNote('greenhouse', id, 'Moved')
        expect(await bell('skoll')).toEqual(['Moved'])
        expect(await bell('hati')).toEqual(['Moved'])
        expect(await bell('manni')).toEqual([])
    })

    it('clears for one person only', async () => {
        const id = await add({assignee: 'hati'})
        const {id: comment} = await store.createComment('greenhouse', id, {body: 'Noted'}, agentOf('hati'))
        await store.updateIssue('greenhouse', id, {assignee: 'skoll'}, owner)
        // Now on Skoll's issue, by Hati's agent, so both have it.
        expect(await bell('hati')).toEqual(['Noted'])
        expect(await bell('skoll')).toEqual(['Noted'])
        expect(await store.clearNotices({ids: [comment]}, 'hati')).toBe(1)
        expect(await bell('hati')).toEqual([])
        expect(await bell('hati', 'cleared')).toEqual(['Noted'])
        expect(await bell('skoll')).toEqual(['Noted'])
        expect(await store.clearNotices({ids: [comment]})).toBe(1)
        expect(await bell('skoll')).toEqual([])
    })

    it('clears a member\'s by time, leaving what still waits on them', async () => {
        const id = await add({assignee: 'hati'})
        await store.createComment('greenhouse', id, {body: 'Noted'}, agentOf('hati'))
        await store.createComment('greenhouse', id, {body: 'Which?', asks: 'decision'}, agentOf('hati'))
        await store.clearNotices({before: new Date(Date.now() + 1000).toISOString()}, 'hati')
        expect(await bell('hati')).toEqual(['Which?'])
    })

    it('leaves proposals to the owner', async () => {
        await store.createIssue('greenhouse', {title: 'An idea', proposal: 'pending'}, agentOf('skoll'))
        expect((await store.notices({person: 'skoll'})).length).toBe(1)
        expect(await store.notices({person: 'hati'})).toEqual([])
    })
})

describe('what stays the owner\'s alone', () => {
    it('is every one of these rows, with a member cell on every row', () => {
        for (const row of PERMISSIONS) expect(row.member, row.id).toBeDefined()
        for (const id of ['presets.write', 'settings.write', 'secrets.write', 'secrets.egress', 'database.write', 'schedules.session', 'schedules.message', 'schedules.action', 'chats.use']) {
            expect(PERMISSIONS.find(row => row.id === id)?.member.level, id).toBe('owner')
        }
    })
})

describe('with one person', () => {
    it('keeps the bell, its clearing and the signals as they were', async () => {
        const solo = new Store(testDb(), () => {}, signal => signals.push(signal))
        await solo.createProject({name: 'cellar', key: 'CEL'})
        await solo.nameOwner({name: 'Skoll'})
        const {id} = await solo.createIssue('cellar', {title: 'Racks'}, owner)
        const comment = await solo.createComment('cellar', id, {body: 'Done'}, {name: 'claude', owner: false, asked: true})
        expect((await solo.notices()).map(n => n.body)).toEqual(['Done'])
        await solo.createComment('cellar', id, {body: 'Thanks'}, owner)
        const signal = signals.at(-1) as Signal
        expect(signal.protected).toBe(true)
        expect(signal.person).toBeUndefined()
        expect(await solo.clearNotices({ids: [comment.id]})).toBe(1)
        expect((await solo.notices()).length).toBe(0)
    })
})
