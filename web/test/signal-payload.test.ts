import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {signalPayload} from '../server/utils/signal-payload'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// What a signal says as its stream sends it to a session (ORR-500): a message (and whose schedule it is), a chunk focus
// with its open issues (marking those another session is on), a focus with its prompt and a release's freeze, and
// anything else on an issue with where it sits. Against a real store; only the schedules are stubbed.
const me = {name: 'skoll', owner: true}
const api = 'http://orrery.test/api/projects/shop'
let store: Store

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO', release_mode: 'own'}, me)
    await store.createRelease('shop', {version: '1.0', frozen_on: '2026-10-28'}, me)
    await store.createIssue('shop', {title: 'Pay with cards', priority: 'P2', status: 'todo'}, me)
    await store.createIssue('shop', {title: 'Refunds', priority: 'P0', status: 'todo', release: '1.0'}, me)
    await store.createIssue('shop', {title: 'Receipts', parent: 'SHO-2', status: 'todo'}, me)
    vi.stubGlobal('useScheduler', () => ({
        get: async (_project: string, id: number) => {
            if (id !== 7) throw Object.assign(new Error(`No schedule ${id}`), {statusCode: 404})
            return {id, title: 'Nightly triage'}
        },
    }))
})

afterEach(() => vi.unstubAllGlobals())

describe('a signal as a session is told it', () => {
    it("is a message as written, saying when the owner's chat sent it", async () => {
        const sent = await store.messageSession('shop', 's-1', 'Wrap up first.', {...me, via: 'chat'})
        expect(await signalPayload(store, 'shop', sent, {api})).toMatchObject({note: 'Wrap up first.\n\n(Sent by the owner through their chat.)', title: null, column: null, chunk: null})
        const plain = await store.messageSession('shop', 's-1', 'Wrap up first.', me)
        expect((await signalPayload(store, 'shop', plain, {api})).note).toBe('Wrap up first.')
    })

    it("names a schedule's message by its schedule, or as a schedule once that's gone", async () => {
        expect(await signalPayload(store, 'shop', await store.message('shop', 7, 'Triage what came in.', me), {api})).toMatchObject({title: 'Nightly triage', column: null})
        expect((await signalPayload(store, 'shop', await store.message('shop', 9, 'Old words.', me), {api})).title).toBe('a schedule')
    })

    it("lists a chunk's open issues most urgent first, by their statuses' names, marking one another session is on", async () => {
        // Started by another session that's there: that's what holds it.
        await store.updateIssue('shop', 'SHO-1', {status: 'in-progress'}, me)
        await store.workedBy('shop', 'SHO-1', 's-other')
        const told = await signalPayload(store, 'shop', await store.focusChunk('shop', 'all', {}, me), {api, me: 's-me'})
        expect(told.issues).toEqual([
            {id: 'SHO-2', title: 'Refunds', column: 'Todo', priority: 'P0'},
            {id: 'SHO-1', title: 'Pay with cards', column: 'In progress', priority: 'P2'},
        ])
        expect(told.prompt).toContain('SHO-1')
        expect(told.prompt).toMatch(/SHO-1[^\n]*another session is on it: skip it/)
        expect(told.prompt).not.toMatch(/SHO-2[^\n]*skip it/)
        // The session on it is told nothing to skip.
        expect((await signalPayload(store, 'shop', await store.focusChunk('shop', 'all', {}, me), {api, me: 's-other'})).prompt).not.toContain('skip it')
    })

    it("gives a focus its prompt, with the issue's address as the session reaches it", async () => {
        const told = await signalPayload(store, 'shop', await store.focus('shop', 'SHO-1', {note: 'Cards first.'}, me), {api})
        expect(told).toMatchObject({title: 'Pay with cards', column: 'Todo', priority: 'P2'})
        expect(told.prompt).toContain(`${api}/issues/SHO-1`)
        expect(told.prompt).toContain('Cards first.')
        expect(told.prompt).not.toContain('feature freeze')
    })

    it("says a release is in feature freeze, for a sub-issue through its parent's release too", async () => {
        for (const id of ['SHO-2', 'SHO-3']) {
            const told = await signalPayload(store, 'shop', await store.focus('shop', id, {}, me), {api})
            expect(told.prompt, id).toContain('1.0 is in feature freeze (since 2026-10-28)')
        }
    })

    it('tells anything else on an issue with where it sits, and no prompt', async () => {
        await store.createComment('shop', 'SHO-1', {body: 'Use the new gateway.'}, me)
        const [comment] = (await store.listSignals('shop', 0)).filter(s => s.kind === 'comment')
        const told = await signalPayload(store, 'shop', comment!, {api})
        expect(told).toMatchObject({title: 'Pay with cards', column: 'Todo', priority: 'P2', chunk: 'No chunk'})
        expect(told).not.toHaveProperty('prompt')
    })
})
