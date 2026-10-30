// Issue dependencies (ORR-601): links made and dropped, what they're read as each way, the loops and pairs they
// refuse, and what holds an issue back. The store, against a fresh database with the project `greenhouse`.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store

beforeEach(async () => {
    ({store} = await storeSetup())
})

const add = async (body: Record<string, unknown> = {}) => (await store.createIssue('greenhouse', {title: 'Work', status: 'todo', ...body})).id
const read = async (id: string, project = 'greenhouse') => await store.issue(project, id)
const move = async (id: string, status: string) => await store.updateIssue('greenhouse', id, {status})

describe('depends_on', () => {
    it('is set on create and replaced on edit, and read back each way', async () => {
        const a = await add()
        const b = await add()
        const c = await add({depends_on: [a]})
        expect((await read(c)).depends_on).toEqual([a])
        expect((await read(a)).blocks).toEqual([c])

        await store.updateIssue('greenhouse', c, {depends_on: [b]})
        expect((await read(c)).depends_on).toEqual([b])
        expect((await read(a)).blocks).toBeUndefined()
        expect((await read(b)).blocks).toEqual([c])

        await store.updateIssue('greenhouse', c, {depends_on: []})
        expect((await read(c)).depends_on).toBeUndefined()
    })

    it('records each change in the activity', async () => {
        const a = await add()
        const c = await add()
        await store.updateIssue('greenhouse', c, {depends_on: [a]})
        await store.updateIssue('greenhouse', c, {depends_on: []})
        const changes = (await store.listActivity('greenhouse', c)).filter(e => e.field === 'depends')
        expect(changes.map(e => [e.before, e.after])).toEqual([[undefined, JSON.stringify([a])], [JSON.stringify([a]), undefined]])
    })

    it('refuses the issue itself, an issue not there, and too many', async () => {
        const a = await add()
        expect((await failure(() => store.updateIssue('greenhouse', a, {depends_on: [a]}))).message).toMatch(/can't depend on itself/)
        expect((await failure(() => store.updateIssue('greenhouse', a, {depends_on: ['GRE-99']}))).status).toBe(404)
        const many = await Promise.all(Array.from({length: 51}, () => add()))
        expect((await failure(() => store.updateIssue('greenhouse', a, {depends_on: many}))).message).toMatch(/50 issues at most/)
    })

    it('refuses a loop, near or far, naming the way round', async () => {
        const a = await add()
        const b = await add({depends_on: [a]})
        const c = await add({depends_on: [b]})
        expect((await failure(() => store.updateIssue('greenhouse', a, {depends_on: [b]}))).message).toBe(`${b} already depends on ${a}, so ${a} can't depend on it`)
        expect((await failure(() => store.updateIssue('greenhouse', a, {depends_on: [c]}))).message).toBe(`${c} already depends on ${a} (through ${b}), so ${a} can't depend on it`)
    })

    it('refuses a parent and its own sub-issue', async () => {
        const parent = await add()
        const sub = await add({parent})
        expect((await failure(() => store.updateIssue('greenhouse', sub, {depends_on: [parent]}))).message).toMatch(/parent and its sub-issue/)
        expect((await failure(() => store.updateIssue('greenhouse', parent, {depends_on: [sub]}))).message).toMatch(/parent and its sub-issue/)
        expect((await failure(() => store.createIssue('greenhouse', {title: 'x', parent, depends_on: [parent]}))).message).toMatch(/is this issue's parent/)
    })

    it('links issues across projects', async () => {
        await store.createProject({name: 'pantry', key: 'PAN'})
        const shelf = (await store.createIssue('pantry', {title: 'Shelf', status: 'todo'})).id
        const c = await add({depends_on: [`pantry/${shelf}`]})
        expect((await read(c)).blocked_by).toEqual([`pantry/${shelf}`])
        expect((await read(shelf, 'pantry')).blocks).toEqual([`greenhouse/${c}`])
        await store.updateIssue('pantry', shelf, {status: 'done'})
        expect((await read(c)).blocked_by).toBeUndefined()
    })

    it('goes with a deleted blocker, as a change on what depended on it', async () => {
        const a = await add()
        const b = await add()
        const c = await add({depends_on: [a, b]})
        await store.deleteIssue('greenhouse', a)
        expect((await read(c)).depends_on).toEqual([b])
        const last = (await store.listActivity('greenhouse', c)).filter(e => e.field === 'depends').at(-1)
        expect([last?.before, last?.after, last?.created_by]).toEqual([JSON.stringify([a, b]), JSON.stringify([b]), 'orrery'])
    })
})

describe('blocked', () => {
    it('lasts until every blocker is done (fan-in), and a done one frees all that wait on it (fan-out)', async () => {
        const a = await add()
        const b = await add()
        const c = await add({depends_on: [a, b]})
        const d = await add({depends_on: [a]})
        expect((await read(c)).blocked_by).toEqual([a, b])
        await move(a, 'done')
        expect((await read(c)).blocked_by).toEqual([b])
        expect((await read(d)).blocked_by).toBeUndefined()
        await move(b, 'done')
        expect((await read(c)).blocked_by).toBeUndefined()
    })

    it('holds while a blocker is open in any status, or canceled, and again once it reopens', async () => {
        const a = await add()
        const c = await add({depends_on: [a]})
        for (const status of ['backlog', 'todo', 'in-progress', 'in-review', 'canceled']) {
            await move(a, status)
            expect((await read(c)).blocked_by, status).toEqual([a])
        }
        await move(a, 'done')
        expect((await read(c)).blocked_by).toBeUndefined()
        await move(a, 'todo')
        expect((await read(c)).blocked_by).toEqual([a])
    })

    it('names only the direct blocker down a chain', async () => {
        const a = await add()
        const b = await add({depends_on: [a]})
        const c = await add({depends_on: [b]})
        expect((await read(c)).blocked_by).toEqual([b])
    })

    it("waits on a parent's own status, not its sub-issues'", async () => {
        const parent = await add()
        await add({parent, status: 'done'})
        const c = await add({depends_on: [parent]})
        expect((await read(c)).blocked_by).toEqual([parent])
        await move(parent, 'done')
        expect((await read(c)).blocked_by).toBeUndefined()
    })

    it('filters the list', async () => {
        const a = await add()
        const c = await add({depends_on: [a]})
        expect((await store.listIssues('greenhouse', {blocked: 'true'})).map(i => i.id)).toEqual([c])
        expect((await store.listIssues('greenhouse', {blocked: 'false'})).map(i => i.id)).toEqual([a])
    })

    it("turns a session away from starting one, unless the owner pointed a session at it", async () => {
        const a = await add()
        const c = await add({depends_on: [a]})
        expect((await failure(() => store.claim('greenhouse', c, 'in-progress', 'sess-1'))).message).toBe(`${c} is blocked by ${a}, which isn't done yet; pick another issue`)
        // Closing it, or a comment, is still anyone's.
        await store.claim('greenhouse', c, 'canceled', 'sess-1')
        await store.claim('greenhouse', c, undefined, 'sess-1')
        await store.focus('greenhouse', c, {}, {name: 'steffen', owner: true})
        await store.claim('greenhouse', c, 'in-progress', 'sess-1')
    })
})
