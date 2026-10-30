import {beforeEach, describe, expect, it} from 'vitest'
import {DEFAULT_PRESETS} from '#shared/presets'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
let store: Store

beforeEach(async () => {
    store = new Store(testDb())
})

const names = async () => (await store.presets()).map(p => p.name)

async function failure(call: () => unknown): Promise<{status: number, message: string}> {
    try {
        await call()
    } catch (error) {
        const {statusCode, message} = error as {statusCode: number, message: string}
        return {status: statusCode, message}
    }
    throw new Error('it did not fail')
}

describe('the presets orrery ships', () => {
    it('are seeded once into a new orrery, the orrery\'s own, each knowing its key', async () => {
        expect(await store.seedPresets()).toBe(DEFAULT_PRESETS.length)
        expect(await store.seedPresets()).toBe(0)
        const presets = await store.presets()
        expect(presets.map(p => p.name).sort()).toEqual(DEFAULT_PRESETS.map(d => d.name).sort())
        expect(presets.every(p => p.project === null && p.default && !p.default.changed)).toBe(true)
        expect(presets.find(p => p.name === 'Review')).toMatchObject({icon: 'eye', color: 'teal', default: {key: 'review', changed: false}})
    })

    it('take a new text on the next start while still as they shipped, and keep the owner\'s own (ORR-611)', async () => {
        const review = DEFAULT_PRESETS.find(d => d.key === 'review')!
        expect(review.text).toMatch(/You only review\. Never start an issue, write the fix or push to its branch/)
        expect(review.text).toMatch(/sub-issue of the reviewed issue/)
        await store.seedPresets()
        const saved = (await store.presets()).find(p => p.default?.key === 'review')!
        const own = await store.createPreset(null, {name: 'Old review', text: review.was![0]!}, me)
        await store.updatePreset(saved.id, {text: review.was![0]!}, me)
        await store.seedPresets()
        expect((await store.preset(saved.id))).toMatchObject({text: review.text, default: {changed: false}})
        // One the owner made with the same words isn't one orrery shipped, so it stays theirs.
        expect((await store.preset(own.id)).text).toBe(review.was![0])
        await store.updatePreset(saved.id, {text: 'My way.'}, me)
        await store.seedPresets()
        expect((await store.preset(saved.id)).text).toBe('My way.')
    })

    it('are seeded into an orrery that has presets of its own, leaving those be', async () => {
        await store.createPreset(null, {name: 'Review', text: 'My own way of reviewing.'}, me)
        await store.seedPresets()
        const reviews = (await store.presets()).filter(p => p.name === 'Review')
        expect(reviews.map(p => p.default?.key ?? null).sort()).toEqual(['review', null].sort())
    })

    it("aren't seeded again once removed, and Restore defaults brings them back as shipped", async () => {
        await store.seedPresets()
        const release = (await store.presets()).find(p => p.default?.key === 'release')!
        await store.deletePreset(release.id, me)
        expect(await store.seedPresets()).toBe(0)
        expect(await names()).not.toContain('Release')
        expect(await failure(() => store.restorePresets(agent))).toMatchObject({status: 403})
        expect((await store.restorePresets(me)).map(p => p.name)).toEqual(['Release'])
        expect(await names()).toContain('Release')
        expect(await store.restorePresets(me)).toEqual([])
    })

    it('are never changed by a seed, and Reset to default puts one back as shipped', async () => {
        await store.seedPresets()
        const review = (await store.presets()).find(p => p.default?.key === 'review')!
        const changed = await store.updatePreset(review.id, {name: 'Review, strictly', text: 'Block on any bug.', icon: null}, me)
        expect(changed.default).toEqual({key: 'review', changed: true})
        await store.seedPresets()
        expect((await store.preset(review.id)).text).toBe('Block on any bug.')
        expect(await failure(() => store.resetPreset(review.id, agent))).toMatchObject({status: 403})
        const shipped = DEFAULT_PRESETS.find(d => d.key === 'review')!
        expect(await store.resetPreset(review.id, me)).toMatchObject({name: shipped.name, text: shipped.text, icon: shipped.icon, color: shipped.color, default: {changed: false}})
    })

    it("can't reset one orrery doesn't ship", async () => {
        const own = await store.createPreset(null, {name: 'Mine', text: 'Mine.'}, me)
        expect(own.default).toBeUndefined()
        expect(await failure(() => store.resetPreset(own.id, me))).toMatchObject({status: 409})
    })
})
