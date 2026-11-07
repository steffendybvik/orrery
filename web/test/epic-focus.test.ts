import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {signalPayload} from '../server/utils/signal-payload'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// Focus on this on an epic (ORR-987): a milestone-style focus for each project the epic has open issues in, narrowed to
// the epic's issues (a sub-issue's through its parent), told to a session as the epic. Against a real store.
const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
const api = (project: string) => `http://orrery.test/api/projects/${project}`
let store: Store
let epic: number

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO'}, me)
    await store.createProject({name: 'api', key: 'API'}, me)
    await store.createProject({name: 'docs', key: 'WIK'}, me)
    epic = (await store.createEpic({title: 'Checkout tracking'}, me)).id
    await store.createIssue('shop', {title: 'Track the checkout', priority: 'P1', status: 'todo', epic}, me)
    await store.createIssue('shop', {title: 'Send the event', parent: 'SHO-1', status: 'todo'}, me)
    await store.createIssue('shop', {title: 'Not in it', priority: 'P0', status: 'todo'}, me)
    await store.createIssue('api', {title: 'Blocker', status: 'todo'}, me)
    await store.createIssue('api', {title: 'Store the attribution', status: 'todo', epic}, me)
    await store.createIssue('api', {title: 'Behind it', status: 'todo', epic, depends_on: ['API-1']}, me)
    // A project whose part is done hears nothing.
    await store.createIssue('docs', {title: 'Write it up', status: 'done', epic}, me)
    vi.stubGlobal('useScheduler', () => ({get: async () => ({title: 'a schedule'})}))
})

afterEach(() => vi.unstubAllGlobals())

describe("an epic's focus", () => {
    it('is one focus for each project with open work in it, narrowed to the epic', async () => {
        const signals = await store.focusEpic(epic, {note: 'Tracking first.'}, me)
        expect(signals.map(s => [s.project, s.milestone, s.epic, s.target, s.protected])).toEqual([['api', 'all', epic, undefined, true], ['shop', 'all', epic, undefined, true]])

        const shop = await signalPayload(store, 'shop', signals[1]!, {api: api('shop')})
        expect(shop.issues?.map(i => i.id)).toEqual(['SHO-1'])
        expect(shop.title).toBe('Checkout tracking')
        expect(shop.prompt).toContain('in epic 1: Checkout tracking')
        expect(shop.prompt).not.toContain('milestone')
        expect(shop.prompt).toContain('http://orrery.test/api/epics/1')
        expect(shop.prompt).toContain('Tracking first.')
        expect(shop.prompt).not.toContain('Not in it')

        // A blocked one is named, but not to start.
        const part = await signalPayload(store, 'api', signals[0]!, {api: api('api')})
        expect(part.issues?.map(i => i.id)).toEqual(['API-2'])
        expect(part.prompt).toMatch(/API-3[^\n]*blocked by API-1/)
    })

    it('can go to every session on each project, but not to a release', async () => {
        expect((await store.focusEpic(epic, {session: '*'}, me)).map(s => s.target)).toEqual(['*', '*'])
        await expect(store.focusEpic(epic, {release: '1.0'}, me)).rejects.toMatchObject({statusCode: 400})
        await expect(store.focusEpic(99, {}, me)).rejects.toMatchObject({statusCode: 404})
    })

    it('goes to a named session in each of the projects it hears, refused when it hears none (ORR-958)', async () => {
        store.hears = (project, session) => session === 's-1' && project === 'shop' || session === 's-2'
        expect((await store.focusEpic(epic, {session: 's-1'}, me)).map(s => [s.project, s.target])).toEqual([['shop', 's-1']])
        expect((await store.focusEpic(epic, {session: 's-2'}, me)).map(s => [s.project, s.target])).toEqual([['api', 's-2'], ['shop', 's-2']])
        // The docs project's part is done, so hearing only it is hearing none of the open ones.
        store.hears = (project, session) => session === 's-3' && project === 'docs'
        await expect(store.focusEpic(epic, {session: 's-3'}, me)).rejects.toMatchObject({statusCode: 400})
    })

    it('narrowed to a status, goes only to the projects with an open issue of it in the epic (ORR-958)', async () => {
        await store.updateIssue('shop', 'SHO-2', {status: 'in-progress'}, me)
        expect((await store.focusEpic(epic, {status: 'in-progress'}, me)).map(s => [s.project, s.status])).toEqual([['shop', 'in-progress']])
        expect((await store.focusEpic(epic, {status: 'todo'}, me)).map(s => s.project)).toEqual(['api'])
        // A kind, or the old word for it, as a milestone's takes.
        expect((await store.focusEpic(epic, {status: 'doing'}, me)).map(s => s.project)).toEqual(['shop'])
    })

    it("is an agent's as theirs, which no session hears", async () => {
        expect((await store.focusEpic(epic, {}, agent)).every(s => !s.protected)).toBe(true)
    })

    it('sends nothing for an epic with no open issues', async () => {
        const empty = (await store.createEpic({title: 'Empty'}, me)).id
        expect(await store.focusEpic(empty, {}, me)).toEqual([])
    })
})
