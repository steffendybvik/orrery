import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Counting feature use (ORR-881): kept in memory and sent to the Rust API once a minute, only while the server allows
// it. The API keeps them only while the owner has counting on, and answers the reads and the forgetting
// (api/src/routes/usage_tests.rs, ORR-1089). This server touches no row for it (ORR-1136).
let usage: typeof import('../server/utils/usage')
let config: Record<string, unknown>
let sent: unknown[][]
const NOW = new Date('2026-11-04T12:00:00Z')
const owner = {name: 'skoll', owner: true}

beforeEach(async () => {
    config = {usage: ''}
    sent = []
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('useDatabase', () => { throw new Error('usage reads and writes no row here') })
    vi.stubGlobal('useStore', () => { throw new Error('usage reads no setting here') })
    vi.doMock('../server/utils/api-router', () => ({writeToApi: async (...args: unknown[]) => { sent.push(args); return {reply: null} }}))
    vi.resetModules()
    usage = await import('../server/utils/usage')
})
afterEach(() => {
    vi.doUnmock('../server/utils/api-router')
    vi.unstubAllGlobals()
})

const counts = () => sent.map(args => (args[2] as {counts: unknown[]}).counts)

describe('counting feature use', () => {
    it('sends a count a feature a day, adding up what gathered, then starts again', async () => {
        usage.countUse('milestones', NOW)
        usage.countUse('milestones', NOW)
        usage.countUse('page:sessions', NOW)
        usage.countUse('milestones', new Date('2026-11-03T09:00:00Z'))
        await usage.flushUse()
        usage.countUse('milestones', NOW)
        await usage.flushUse()
        expect(sent[0]).toEqual(['PUT', '/api/usage', {counts: [
            {feature: 'milestones', day: '2026-11-04', count: 2},
            {feature: 'page:sessions', day: '2026-11-04', count: 1},
            {feature: 'milestones', day: '2026-11-03', count: 1},
        ]}, {name: 'orrery', owner: false}, {always: true}])
        expect(counts()[1]).toEqual([{feature: 'milestones', day: '2026-11-04', count: 1}])
    })

    it('sends nothing when nothing gathered', async () => {
        await usage.flushUse()
        expect(sent).toEqual([])
    })

    it("sends nothing on a server that doesn't allow it, and drops what gathered", async () => {
        config.usage = 'off'
        usage.countUse('milestones', NOW)
        await usage.flushUse()
        config.usage = ''
        await usage.flushUse()
        expect(sent).toEqual([])
    })

    it("ignores a name that isn't a feature's", async () => {
        for (const name of ['', 'Milestones', 'page:../etc', 'dialog:New issue', 'popup:new-issue', 'evil<script>', 'x'.repeat(41)]) usage.countUse(name, NOW)
        usage.countUse('dialog:new-issue', NOW)
        await usage.flushUse()
        expect(counts()).toEqual([[{feature: 'dialog:new-issue', day: '2026-11-04', count: 1}]])
    })

    it('drops what gathered when the counts are forgotten', async () => {
        usage.countUse('milestones', NOW)
        usage.dropGathered()
        await usage.flushUse()
        expect(sent).toEqual([])
    })
})

// The route that counts a use (ORR-888): anyone else's `POST` is dropped with the same 204, saying nothing of whether
// counting is on.
describe("Usage's route", () => {
    type Who = {name: string, owner: boolean, untrusted?: boolean}
    type Event = {context: {who?: Who}, body?: unknown, status?: number}
    const member: Who = {name: 'hati', owner: false}
    const session: Who = {name: 'claude', owner: false, untrusted: true}

    beforeEach(() => {
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
        vi.stubGlobal('readBody', async (event: Event) => event.body)
        vi.stubGlobal('setResponseStatus', (event: Event, status: number) => { event.status = status })
        vi.stubGlobal('countUse', usage.countUse)
    })

    const call = async (who: Who | undefined, body?: unknown) => {
        const handler = (await import('../server/api/usage/index.post.ts')).default as (event: Event) => Promise<unknown>
        const event: Event = {context: who ? {who} : {}, body}
        await handler(event)
        return event.status
    }

    it("counts the owner's use, and drops anyone else's with the same 204", async () => {
        for (const who of [member, session]) expect(await call(who, {feature: 'milestones'})).toBe(204)
        await usage.flushUse()
        expect(sent).toEqual([])
        expect(await call(owner, {feature: 'milestones'})).toBe(204)
        await usage.flushUse()
        expect(counts()[0]).toMatchObject([{feature: 'milestones', count: 1}])
    })
})
