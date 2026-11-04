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
        usage.countUse('chunks', NOW)
        await usage.flushUse(NOW)
        await store.updateSettings({count_use: true}, owner)
        await usage.flushUse(NOW)
        expect(await counted()).toEqual([])
    })

    it('once on, writes a row a feature a day, adding to it', async () => {
        await store.updateSettings({count_use: true}, owner)
        usage.countUse('chunks', NOW)
        usage.countUse('chunks', NOW)
        usage.countUse('page:sessions', NOW)
        await usage.flushUse(NOW)
        usage.countUse('chunks', NOW)
        await usage.flushUse(NOW)
        expect(await counted()).toEqual([
            {feature: 'chunks', day: '2026-11-04', count: 3},
            {feature: 'page:sessions', day: '2026-11-04', count: 1},
        ])
    })

    it("counts nothing on a server that doesn't allow it, whatever the setting", async () => {
        await store.updateSettings({count_use: true}, owner)
        config.usage = 'off'
        usage.countUse('chunks', NOW)
        await usage.flushUse(NOW)
        expect(await counted()).toEqual([])
    })

    it("ignores a name that isn't a feature's", async () => {
        await store.updateSettings({count_use: true}, owner)
        for (const name of ['', 'Chunks', 'page:../etc', 'evil<script>', 'x'.repeat(41)]) usage.countUse(name, NOW)
        await usage.flushUse(NOW)
        expect(await counted()).toEqual([])
    })

    it('lists every listed feature, coldest first, with its last use and its uses over 30 and 90 days', async () => {
        await store.updateSettings({count_use: true}, owner)
        usage.countUse('chunks', new Date('2026-10-20T09:00:00Z'))
        usage.countUse('chunks', new Date('2026-08-20T09:00:00Z'))
        for (let i = 0; i < 3; i++) usage.countUse('schedules', NOW)
        await usage.flushUse(NOW)
        const list = await usage.featureUse(NOW)
        expect(list.find(f => f.feature === 'chunks')).toEqual({feature: 'chunks', label: 'Making a chunk', last: '2026-10-20', days30: 1, days90: 2})
        expect(list.find(f => f.feature === 'presets')).toEqual({feature: 'presets', label: 'Making a preset', last: null, days30: 0, days90: 0})
        expect(list.at(-1)!.feature).toBe('schedules')
        expect(list[0]!.days90).toBe(0)
    })

    it('forgets rows over a year old, and every row when asked', async () => {
        await store.updateSettings({count_use: true}, owner)
        usage.countUse('chunks', new Date('2025-10-01T09:00:00Z'))
        usage.countUse('schedules', NOW)
        await usage.flushUse(NOW)
        expect((await counted()).map(r => r.feature)).toEqual(['schedules'])
        await usage.forgetUse()
        expect(await counted()).toEqual([])
    })
})

// The routes behind App settings' Usage (ORR-888): the counts are the owner's own record, so only the owner reads or
// wipes them, and anyone else's `POST` is dropped with the same 204, saying nothing of whether counting is on.
describe("Usage's routes", () => {
    type Who = {name: string, owner: boolean, untrusted?: boolean}
    type Event = {context: {who?: Who}, body?: unknown, status?: number}
    const member: Who = {name: 'hati', owner: false}
    const session: Who = {name: 'claude', owner: false, untrusted: true}

    beforeEach(async () => {
        const {forbidden} = await import('../server/utils/input')
        const {ownerOnly} = await import('../server/utils/permission')
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
        vi.stubGlobal('actorOf', async (event: Event) => event.context.who ?? {name: 'nobody', owner: false})
        vi.stubGlobal('readBody', async (event: Event) => event.body)
        vi.stubGlobal('setResponseStatus', (event: Event, status: number) => { event.status = status })
        vi.stubGlobal('forbidden', forbidden)
        vi.stubGlobal('ownerOnly', ownerOnly)
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

    it("reads the counts for the owner alone", async () => {
        expect((await call('index.get', owner)).data).toMatchObject({on: true, allowed: true})
        for (const who of [member, session, undefined]) expect((await call('index.get', who)).status).toBe(403)
    })

    it('wipes them for the owner alone', async () => {
        usage.countUse('chunks', NOW)
        await usage.flushUse(NOW)
        for (const who of [member, session, undefined]) expect((await call('index.delete', who)).status).toBe(403)
        expect(await counted()).toHaveLength(1)
        expect((await call('index.delete', owner)).status).toBe(204)
        expect(await counted()).toEqual([])
    })

    it("counts the owner's use, and drops anyone else's with the same 204", async () => {
        for (const who of [member, session]) expect((await call('index.post', who, {feature: 'chunks'})).status).toBe(204)
        await usage.flushUse()
        expect(await counted()).toEqual([])
        expect((await call('index.post', owner, {feature: 'chunks'})).status).toBe(204)
        await usage.flushUse()
        expect((await counted()).map(r => [r.feature, r.count])).toEqual([['chunks', 1]])
    })
})
