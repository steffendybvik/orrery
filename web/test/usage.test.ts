import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Store} from '../server/utils/store'
import type {Db} from '../server/utils/database'
import {testDb} from './db'

// Counting feature use (ORR-881): kept in memory, written once a minute, only while the owner has it on and the server
// allows it, and read back coldest first for App settings' Usage.
let usage: typeof import('../server/utils/usage')
let db: Db
let store: Store
let config: Record<string, unknown>
const NOW = new Date('2026-11-04T12:00:00Z')
const owner = {name: 'skoll', owner: true}

beforeEach(async () => {
    db = testDb()
    store = new Store(db)
    config = {usage: ''}
    vi.stubGlobal('useDatabase', () => db)
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.resetModules()
    usage = await import('../server/utils/usage')
})
afterEach(() => vi.unstubAllGlobals())

const counted = async () => db.all<{feature: string, day: string, count: number}>('SELECT feature, day, count FROM feature_use ORDER BY feature, day')

describe('counting feature use', () => {
    it('counts nothing while it is off, as it is by default, and drops what gathered meanwhile', async () => {
        expect((await store.settings()).count_use).toBe(false)
        usage.countUse('milestones', NOW)
        await usage.flushUse(NOW)
        await store.updateSettings({count_use: true}, owner)
        await usage.flushUse(NOW)
        expect(await counted()).toEqual([])
    })

    it('once on, writes a row a feature a day, adding to it', async () => {
        await store.updateSettings({count_use: true}, owner)
        usage.countUse('milestones', NOW)
        usage.countUse('milestones', NOW)
        usage.countUse('page:sessions', NOW)
        await usage.flushUse(NOW)
        usage.countUse('milestones', NOW)
        await usage.flushUse(NOW)
        expect(await counted()).toEqual([
            {feature: 'milestones', day: '2026-11-04', count: 3},
            {feature: 'page:sessions', day: '2026-11-04', count: 1},
        ])
    })

    it("counts nothing on a server that doesn't allow it, whatever the setting", async () => {
        await store.updateSettings({count_use: true}, owner)
        config.usage = 'off'
        usage.countUse('milestones', NOW)
        await usage.flushUse(NOW)
        expect(await counted()).toEqual([])
    })

    it("ignores a name that isn't a feature's", async () => {
        await store.updateSettings({count_use: true}, owner)
        for (const name of ['', 'Milestones', 'page:../etc', 'dialog:New issue', 'popup:new-issue', 'evil<script>', 'x'.repeat(41)]) usage.countUse(name, NOW)
        await usage.flushUse(NOW)
        expect(await counted()).toEqual([])
    })

    it('counts each dialog opened under its name, labelled by it (ORR-1011)', async () => {
        await store.updateSettings({count_use: true}, owner)
        usage.countUse('dialog:new-issue', NOW)
        usage.countUse('dialog:new-issue', NOW)
        await usage.flushUse(NOW)
        expect((await usage.featureUse(NOW)).find(f => f.feature === 'dialog:new-issue')).toEqual(
            {feature: 'dialog:new-issue', label: 'new-issue', last: '2026-11-04', days30: 2, days90: 2})
    })

    it('lists every listed feature, coldest first, with its last use and its uses over 30 and 90 days', async () => {
        await store.updateSettings({count_use: true}, owner)
        usage.countUse('milestones', new Date('2026-10-20T09:00:00Z'))
        usage.countUse('milestones', new Date('2026-08-20T09:00:00Z'))
        for (let i = 0; i < 3; i++) usage.countUse('schedules', NOW)
        await usage.flushUse(NOW)
        const list = await usage.featureUse(NOW)
        expect(list.find(f => f.feature === 'milestones')).toEqual({feature: 'milestones', label: 'Making a milestone', last: '2026-10-20', days30: 1, days90: 2})
        expect(list.find(f => f.feature === 'presets')).toEqual({feature: 'presets', label: 'Making a preset', last: null, days30: 0, days90: 0})
        expect(list.at(-1)!.feature).toBe('schedules')
        expect(list[0]!.days90).toBe(0)
    })

    it('forgets rows over a year old, and every row when asked', async () => {
        await store.updateSettings({count_use: true}, owner)
        usage.countUse('milestones', new Date('2025-10-01T09:00:00Z'))
        usage.countUse('schedules', NOW)
        await usage.flushUse(NOW)
        expect((await counted()).map(r => r.feature)).toEqual(['schedules'])
        await usage.forgetUse()
        expect(await counted()).toEqual([])
    })
})

// The route that counts a use (ORR-888): anyone else's `POST` is dropped with the same 204, saying nothing of whether
// counting is on. Reading and wiping the counts are the Rust API's (api/src/routes/usage.rs, ORR-1089).
describe('with the Rust API in front (ORR-1089)', () => {
    it('sends what gathered to it, and writes nothing here', async () => {
        const sent: unknown[] = []
        vi.doMock('../server/utils/api-router', () => ({writeToApi: async (...args: unknown[]) => { sent.push(args); return {reply: null} }}))
        vi.resetModules()
        const viaApi = await import('../server/utils/usage')
        await store.updateSettings({count_use: true}, owner)
        viaApi.countUse('milestones', NOW)
        viaApi.countUse('milestones', NOW)
        viaApi.countUse('page:board', NOW)
        await viaApi.flushUse(NOW)
        vi.doUnmock('../server/utils/api-router')
        expect(sent).toEqual([['PUT', '/api/usage', {counts: [{feature: 'milestones', day: '2026-11-04', count: 2}, {feature: 'page:board', day: '2026-11-04', count: 1}]}, {name: 'orrery', owner: false}, {always: true}]])
        expect(await counted()).toEqual([])
    })
})

describe("Usage's routes", () => {
    type Who = {name: string, owner: boolean, untrusted?: boolean}
    type Event = {context: {who?: Who}, body?: unknown, status?: number}
    const member: Who = {name: 'hati', owner: false}
    const session: Who = {name: 'claude', owner: false, untrusted: true}

    beforeEach(async () => {
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
        vi.stubGlobal('actorOf', async (event: Event) => event.context.who ?? {name: 'nobody', owner: false})
        vi.stubGlobal('readBody', async (event: Event) => event.body)
        vi.stubGlobal('setResponseStatus', (event: Event, status: number) => { event.status = status })
        for (const name of ['countUse', 'flushUse', 'featureUse', 'forgetUse', 'usageAllowed'] as const) vi.stubGlobal(name, usage[name])
        await store.updateSettings({count_use: true}, owner)
    })

    const call = async (route: string, who: Who | undefined, body?: unknown) => {
        const handler = (await import(`../server/api/usage/${route}.ts`)).default as (event: Event) => Promise<unknown>
        const event: Event = {context: who ? {who} : {}, body}
        try {
            return {data: await handler(event), status: event.status ?? 200}
        } catch (error) {
            return {status: (error as {statusCode: number}).statusCode}
        }
    }

    it("counts the owner's use, and drops anyone else's with the same 204", async () => {
        for (const who of [member, session]) expect((await call('index.post', who, {feature: 'milestones'})).status).toBe(204)
        await usage.flushUse()
        expect(await counted()).toEqual([])
        expect((await call('index.post', owner, {feature: 'milestones'})).status).toBe(204)
        await usage.flushUse()
        expect((await counted()).map(r => [r.feature, r.count])).toEqual([['milestones', 1]])
    })
})
