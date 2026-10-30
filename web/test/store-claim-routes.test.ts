// Claiming, letting go and taking over from the page (ORR-657): a person's own or what's nobody's, and the owner's on anyone's.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Actor, Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store
const owner: Actor = {name: 'skoll', owner: true, asked: true}
const hati: Actor = {name: 'hati', owner: false, asked: true, person: 'hati'}
const manni: Actor = {name: 'manni', owner: false, asked: true, person: 'manni'}
const agentOf = (named?: string): Actor => ({name: 'claude', owner: false, asked: true, session: 'w', ...named ? {named} : {}})
const add = async (assignee?: string) => (await store.createIssue('greenhouse', {title: 'Seed trays', ...assignee ? {assignee} : {}}, owner)).id
const refused = async (run: () => Promise<unknown>, says: string) => {
    const {status, message} = await failure(run)
    expect(status).toBe(409)
    expect(message).toContain(says)
}
const lastActivity = async (id: string) => (await store.listActivity('greenhouse', id)).at(-1)

beforeEach(async () => {
    ({store} = await storeSetup())
    await store.nameOwner({name: 'Skoll'})
    for (const name of ['Hati', 'Manni']) {
        await store.addPerson({name})
        await store.addMember('greenhouse', {person: name.toLowerCase()}, owner)
    }
})

describe('claiming', () => {
    it('takes up a person\'s own, when they did, in the activity', async () => {
        const id = await add('hati')
        expect(await store.claimIssue('greenhouse', id, hati)).toMatchObject({claimed_by: 'hati', assignee: 'hati', claimed_at: expect.any(String)})
        expect(await lastActivity(id)).toMatchObject({field: 'claim', after: 'hati', created_by: 'hati'})
    })

    it('assigns what\'s nobody\'s to the person taking it up, but not to their agent', async () => {
        const id = await add()
        await refused(() => store.claimIssue('greenhouse', id, agentOf('hati')), 'assigned to nobody')
        expect(await store.claimIssue('greenhouse', id, hati)).toMatchObject({claimed_by: 'hati', assignee: 'hati'})
    })

    it('refuses someone else\'s, naming them, to a member and to an agent', async () => {
        const id = await add('hati')
        for (const actor of [manni, agentOf('manni')]) await refused(() => store.claimIssue('greenhouse', id, actor), 'assigned to hati')
        await refused(() => store.claimIssue('greenhouse', id, agentOf()), 'names nobody')
        expect((await store.issue('greenhouse', id)).claimed_by).toBeUndefined()
    })

    it('lets an agent take up its person\'s', async () => {
        expect(await store.claimIssue('greenhouse', await add('hati'), agentOf('hati'))).toMatchObject({claimed_by: 'hati'})
    })

    it('lets the owner take one over, which shows who from', async () => {
        const id = await add('hati')
        await store.claimIssue('greenhouse', id, hati)
        expect(await store.claimIssue('greenhouse', id, owner)).toMatchObject({claimed_by: 'skoll', assignee: 'skoll'})
        expect(await lastActivity(id)).toMatchObject({field: 'claim', before: 'hati', after: 'skoll'})
    })
})

describe('letting go', () => {
    it('leaves it assigned, in the activity', async () => {
        const id = await add('hati')
        await store.claimIssue('greenhouse', id, hati)
        const after = await store.releaseIssue('greenhouse', id, hati)
        expect(after.claimed_by).toBeUndefined()
        expect(after.assignee).toBe('hati')
        expect(await lastActivity(id)).toMatchObject({field: 'claim', before: 'hati'})
    })

    it('is its holder\'s, their agent\'s or the owner\'s', async () => {
        const id = await add('hati')
        await store.claimIssue('greenhouse', id, hati)
        for (const actor of [manni, agentOf('manni'), agentOf()]) await refused(() => store.releaseIssue('greenhouse', id, actor), 'held by hati')
        expect((await store.releaseIssue('greenhouse', id, agentOf('hati'))).claimed_by).toBeUndefined()
        await store.claimIssue('greenhouse', id, hati)
        expect((await store.releaseIssue('greenhouse', id, owner)).claimed_by).toBeUndefined()
    })

    it('does nothing when nobody holds it', async () => {
        const id = await add('hati')
        const before = (await store.listActivity('greenhouse', id)).length
        await store.releaseIssue('greenhouse', id, manni)
        expect(await store.listActivity('greenhouse', id)).toHaveLength(before)
    })
})
