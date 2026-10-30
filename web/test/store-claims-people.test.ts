// The rails between people (ORR-655): an agent works only what's assigned to its person, by any route into the store.
// Two people with two agents each on one board, and on a one-person orrery nothing of this shows.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Actor} from '../server/utils/store'
import {Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store
const owner: Actor = {name: 'skoll', owner: true, asked: true}
const agent = (named?: string, session = 'window-a'): Actor => ({name: 'claude', owner: false, asked: true, session, ...named ? {named} : {}})
const skolls = agent('skoll')
const hatis = agent('hati')
const add = async (body: Record<string, unknown> = {}) => (await store.createIssue('greenhouse', {title: 'Seed trays', ...body}, owner)).id
const refused = async (run: () => Promise<unknown>, says?: string) => {
    const {status, message} = await failure(run)
    expect(status).toBe(409)
    if (says) expect(message).toContain(says)
}

beforeEach(async () => {
    ({store} = await storeSetup())
    await store.nameOwner({name: 'Skoll'})
})

describe('on a one-person orrery', () => {
    it('claims an unassigned issue, or one assigned to claude, as it does today', async () => {
        const session = agent()
        const a = await add()
        const b = await add({assignee: 'claude'})
        for (const id of [a, b]) expect(await store.updateIssue('greenhouse', id, {status: 'in-progress', assignee: 'claude'}, session)).toMatchObject({status: 'in-progress', assignee: 'claude'})
        expect((await store.issue('greenhouse', a)).claimed_by).toBeUndefined()
        expect((await store.createIssue('greenhouse', {title: 'Started', status: 'in-progress'}, session)).status).toBe('in-progress')
    })

    it('still answers a person-less ask by assigning the owner', async () => {
        const a = await add()
        await store.createComment('greenhouse', a, {body: 'Which?', asks: 'decision'}, agent())
        expect((await store.issue('greenhouse', a)).assignee).toBe('skoll')
    })
})

describe('with two people', () => {
    beforeEach(() => store.addPerson({name: 'Hati'}).then(() => undefined))

    describe('claiming', () => {
        it('lets an agent start what is its person\'s, and records the claim', async () => {
            const id = await add({assignee: 'hati'})
            expect(await store.updateIssue('greenhouse', id, {status: 'in-progress'}, hatis)).toMatchObject({status: 'in-progress', claimed_by: 'hati', assignee: 'hati'})
        })

        it('counts `claude` as the owner\'s, and turns it into nothing new when an agent starts its own', async () => {
            const id = await add({assignee: 'claude'})
            expect(await store.updateIssue('greenhouse', id, {status: 'in-progress', assignee: 'claude'}, skolls)).toMatchObject({claimed_by: 'skoll', assignee: 'claude'})
            await refused(() => store.updateIssue('greenhouse', id, {status: 'in-progress'}, hatis), 'assigned to skoll')
        })

        it('refuses another person\'s, naming them, and an unassigned one, by start, edit or close', async () => {
            const theirs = await add({assignee: 'skoll'})
            const nobodys = await add()
            for (const patch of [{status: 'in-progress'}, {title: 'Mine now'}, {status: 'done'}]) {
                await refused(() => store.updateIssue('greenhouse', theirs, patch, hatis), 'assigned to skoll')
                await refused(() => store.updateIssue('greenhouse', nobodys, patch, hatis), 'assigned to nobody')
            }
        })

        it('counts an assignee who isn\'t a person as nobody\'s', async () => {
            const id = await add({assignee: 'somebody'})
            await refused(() => store.updateIssue('greenhouse', id, {status: 'in-progress'}, hatis), 'assigned to nobody')
        })

        it('refuses a session that names nobody, or somebody unknown, and an untrusted one', async () => {
            const id = await add({assignee: 'hati'})
            for (const actor of [agent(), agent('fenrir'), {...hatis, untrusted: true}]) await refused(() => store.updateIssue('greenhouse', id, {status: 'in-progress'}, actor), 'names nobody')
        })

        it('ends when it\'s closed or reassigned, and reopening doesn\'t bring it back', async () => {
            const id = await add({assignee: 'hati'})
            await store.updateIssue('greenhouse', id, {status: 'in-progress'}, hatis)
            expect((await store.updateIssue('greenhouse', id, {status: 'done'}, hatis)).claimed_by).toBeUndefined()
            expect((await store.updateIssue('greenhouse', id, {status: 'in-progress'}, owner)).claimed_by).toBeUndefined()
            await store.updateIssue('greenhouse', id, {status: 'in-progress'}, hatis)
            expect((await store.updateIssue('greenhouse', id, {assignee: 'skoll'}, owner)).claimed_by).toBeUndefined()
        })

        it('lets another of the same person\'s agents pick it up, and not another person\'s', async () => {
            const id = await add({assignee: 'hati'})
            await store.updateIssue('greenhouse', id, {status: 'in-progress'}, hatis)
            expect((await store.updateIssue('greenhouse', id, {title: 'Next'}, agent('hati', 'window-b'))).claimed_by).toBe('hati')
            await refused(() => store.updateIssue('greenhouse', id, {title: 'Mine'}, agent('skoll', 'window-c')), 'assigned to hati')
        })

        it('lets one of two agents racing win, even from two servers', async () => {
            const id = await add({assignee: 'hati'})
            const other = new Store(store.db)
            const start = (on: Store, session: string) => on.claimed('greenhouse', id, 'in-progress', session,
                () => on.updateIssue('greenhouse', id, {status: 'in-progress'}, agent('hati', session)))
            const results = await Promise.allSettled([start(store, 'window-a'), start(other, 'window-b')])
            expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
            expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.statusCode)).toEqual([409])
        })
    })

    describe('every way in', () => {
        it('holds bulk edits, each on its own', async () => {
            const mine = await add({assignee: 'hati'})
            const theirs = await add({assignee: 'skoll'})
            const results = await store.updateIssues('greenhouse', {ids: [mine, theirs], set: {status: 'in-progress'}}, hatis)
            expect(results.map(r => r.ok)).toEqual([true, false])
            expect(results[1]!.error).toContain('assigned to skoll')
        })

        it('holds a new issue: no parent, it stays nobody\'s, and can\'t be made taken up', async () => {
            const made = await store.createIssue('greenhouse', {title: 'Idea'}, hatis)
            expect(made.assignee).toBeUndefined()
            expect((await store.db.get<{created_person: string}>('SELECT created_person FROM issues WHERE id = ?', made.id))!.created_person).toBe('hati')
            await refused(() => store.createIssue('greenhouse', {title: 'x', status: 'in-progress'}, hatis))
            await refused(() => store.createIssue('greenhouse', {title: 'x', status: 'done'}, hatis))
            await refused(() => store.createIssue('greenhouse', {title: 'x', assignee: 'hati'}, hatis), 'Only people assign')
            await refused(() => store.createIssue('greenhouse', {title: 'x'}, agent()), 'names nobody')
            expect((await store.createIssue('greenhouse', {title: 'For the owner', assignee: 'owner'}, hatis)).assignee).toBe('skoll')
        })

        it('gives a follow-up to the person of its parent, and refuses one under someone else\'s', async () => {
            const mine = await add({assignee: 'hati'})
            const theirs = await add({assignee: 'skoll'})
            expect((await store.createIssue('greenhouse', {title: 'Follow-up', parent: mine}, hatis)).assignee).toBe('hati')
            await refused(() => store.createIssue('greenhouse', {title: 'Follow-up', parent: theirs}, hatis), 'assigned to skoll')
        })

        it('refuses assigning, and getting under an issue it doesn\'t hold', async () => {
            const mine = await add({assignee: 'hati'})
            const theirs = await add({assignee: 'skoll'})
            await refused(() => store.updateIssue('greenhouse', theirs, {assignee: 'hati'}, hatis))
            await refused(() => store.updateIssue('greenhouse', mine, {assignee: 'somebody'}, hatis), 'Only people assign')
            await refused(() => store.updateIssue('greenhouse', mine, {parent: theirs}, hatis), 'assigned to skoll')
            expect((await store.updateIssue('greenhouse', mine, {assignee: 'owner'}, hatis)).assignee).toBe('skoll')
        })

        it('refuses moving or deleting what it doesn\'t hold, and importing', async () => {
            const theirs = await add({assignee: 'skoll'})
            await refused(() => store.updateIssue('greenhouse', theirs, {project: 'greenhouse', title: 'x'}, hatis))
            await refused(() => store.deleteIssue('greenhouse', theirs, hatis), 'assigned to skoll')
            await refused(() => store.importRoadmap('greenhouse', {comment: '', chunks: []}, true, hatis), 'only a person')
        })

        it('leaves comments open to all', async () => {
            const theirs = await add({assignee: 'skoll'})
            expect((await store.createComment('greenhouse', theirs, {body: 'Found this'}, hatis)).body).toBe('Found this')
        })

        it('holds nothing of the owner, or of what orrery does itself', async () => {
            const theirs = await add({assignee: 'hati'})
            expect((await store.updateIssue('greenhouse', theirs, {status: 'in-progress'}, owner)).status).toBe('in-progress')
            expect((await store.updateIssue('greenhouse', theirs, {status: 'todo'}, {name: 'claude', owner: false})).status).toBe('todo')
        })
    })

    describe('what orrery reassigns', () => {
        it('sends an agent\'s question to its person, and doesn\'t let one take an issue by asking', async () => {
            const mine = await add({assignee: 'hati'})
            const theirs = await add({assignee: 'skoll'})
            await store.createComment('greenhouse', mine, {body: 'Which?', asks: 'decision'}, hatis)
            expect((await store.issue('greenhouse', mine)).assignee).toBe('hati')
            await store.createComment('greenhouse', theirs, {body: 'Which?', asks: 'decision'}, hatis)
            expect((await store.issue('greenhouse', theirs)).assignee).toBe('skoll')
        })

        it('sends a proposal under its person\'s issue to the owner, and back to that person once approved', async () => {
            const mine = await add({assignee: 'hati'})
            const {id, assignee, claimed_by} = await store.createIssue('greenhouse', {title: 'Idea', parent: mine, proposal: 'pending', status: 'in-progress'}, hatis)
            expect({assignee, claimed_by}).toEqual({assignee: 'skoll', claimed_by: undefined})
            expect(await store.decide('greenhouse', id, {decision: 'approved'}, owner)).toMatchObject({assignee: 'hati'})
        })

        it('gives an approved proposal to the person whose agent proposed it', async () => {
            const {id} = await store.createIssue('greenhouse', {title: 'Idea', proposal: 'pending'}, hatis)
            expect((await store.issue('greenhouse', id)).assignee).toBe('skoll')
            expect(await store.updateIssue('greenhouse', id, {title: 'Better idea', proposal: 'pending'}, hatis)).toMatchObject({title: 'Better idea'})
            await store.decide('greenhouse', id, {decision: 'approved'}, owner)
            expect((await store.issue('greenhouse', id)).assignee).toBe('hati')
        })
    })

    describe('focus', () => {
        it('on an unassigned issue, makes it the person\'s pointing their agent', async () => {
            const id = await add()
            await store.focus('greenhouse', id, {}, {name: 'hati', owner: false, asked: true})
            expect((await store.issue('greenhouse', id)).assignee).toBe('hati')
        })

        it('on someone else\'s is refused, and an agent can\'t assign itself in', async () => {
            const theirs = await add({assignee: 'skoll'})
            const nobodys = await add()
            await refused(() => store.focus('greenhouse', theirs, {}, {name: 'hati', owner: false, asked: true}), 'assigned to skoll')
            await refused(() => store.focus('greenhouse', nobodys, {}, hatis), 'assigned to nobody')
        })

        it('from the owner takes it over, and that shows', async () => {
            const id = await add({assignee: 'hati'})
            await store.updateIssue('greenhouse', id, {status: 'in-progress'}, hatis)
            await store.focus('greenhouse', id, {}, owner)
            const issue = await store.issue('greenhouse', id)
            expect(issue.assignee).toBe('skoll')
            expect(issue.claimed_by).toBeUndefined()
            expect((await store.listActivity('greenhouse', id)).at(-1)).toMatchObject({field: 'assignee', before: 'hati', after: 'skoll', created_by: 'skoll'})
        })
    })
})

