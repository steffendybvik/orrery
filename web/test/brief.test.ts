import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// What a session's hook hands its fresh context (ORR-501, out of the route): after a clear, a compaction or a resume, the
// issues it has in progress with their last comment and what's left of its run; for a session orrery started with
// context, that context. Against a real store; the run and the launch's context are stubbed.
const me = {name: 'skoll', owner: true}
const api = 'http://orrery.test/api/projects/shop'
let store: Store
let run: Signal | undefined
let context: {text: string} | undefined
let sessionBrief: typeof import('../server/utils/brief').sessionBrief

beforeEach(async () => {
    run = undefined
    context = undefined
    vi.resetModules()
    vi.doMock('../server/utils/clearing', () => ({runOf: () => run}))
    vi.doMock('../server/utils/launches', () => ({
        launchContext: (_project: string, launch: string) => launch === 'l-1' ? context : undefined,
        contextBlock: (c: {text: string}) => `Context: ${c.text}`,
    }))
    ;({sessionBrief} = await import('../server/utils/brief'))
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO'}, me)
    await store.createIssue('shop', {title: 'Pay with cards', priority: 'P2', status: 'in-progress'}, me)
    await store.createIssue('shop', {title: 'Refunds', priority: 'P0', status: 'todo'}, me)
    await store.createIssue('shop', {title: 'Receipts', status: 'todo'}, me)
})

describe("a session's brief", () => {
    it('is none for a session with nothing in progress and no context, whatever started it', async () => {
        for (const source of [undefined, 'startup', 'clear']) {
            expect(await sessionBrief(store, {project: 'shop', session: 's-1', source, api})).toBeUndefined()
        }
    })

    it('carries its issues in progress on after a clear, with their last comment, and what is left of its run', async () => {
        await store.workedBy('shop', 'SHO-1', 's-1')
        await store.createComment('shop', 'SHO-1', {body: 'Cards   work;\nwallets next.'}, me)
        run = {project: 'shop', chunk: 'all'} as Signal
        expect(await sessionBrief(store, {project: 'shop', session: 's-1', source: 'clear', api})).toBe([
            "orrery: this window's context was just cleared.",
            'It was working on these issues in project "shop"; carry on with them:',
            '- SHO-1: Pay with cards [In progress, P2]\n  last comment, by skoll: Cards work; wallets next.',
            'After those, it was working through every chunk in project "shop"; these are left, most urgent first. Take them one at a time (in-progress, comments, done):',
            '- SHO-2: Refunds [Todo, P0]',
            '- SHO-3: Receipts [Todo]',
            `Read each in full (the issue tool, or curl ${api}/issues/<id>) before going on.`,
        ].join('\n'))
        // Not after a plain start: its work is told by its focus then.
        expect(await sessionBrief(store, {project: 'shop', session: 's-1', source: 'startup', api})).toBeUndefined()
    })

    it("gives a started session's context every time, after its work when there's both", async () => {
        context = {text: 'Review it.'}
        expect(await sessionBrief(store, {project: 'shop', session: 's-2', source: 'startup', launch: 'l-1', api})).toBe('Context: Review it.')
        await store.workedBy('shop', 'SHO-1', 's-2')
        const brief = await sessionBrief(store, {project: 'shop', session: 's-2', source: 'compact', launch: 'l-1', api})
        expect(brief).toMatch(/^orrery: this window's context was just compacted\.\n/)
        expect(brief).toMatch(/before going on\.\n\nContext: Review it\.$/)
    })
})
