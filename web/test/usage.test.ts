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
