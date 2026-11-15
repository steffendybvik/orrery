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
    // Seeding them as the server starts is the Rust API's (api/src/routes/presets_tests.rs, ORR-1136).
    it('Restore defaults brings back the ones removed, as shipped', async () => {
        expect((await store.restorePresets(me)).length).toBe(DEFAULT_PRESETS.length)
        const release = (await store.presets()).find(p => p.default?.key === 'release')!
        await store.deletePreset(release.id, me)
        expect(await names()).not.toContain('Release')
        expect(await failure(() => store.restorePresets(agent))).toMatchObject({status: 403})
        expect((await store.restorePresets(me)).map(p => p.name)).toEqual(['Release'])
        expect(await names()).toContain('Release')
        expect(await store.restorePresets(me)).toEqual([])
    })

    it('Reset to default puts one the owner changed back as shipped', async () => {
        await store.restorePresets(me)
        const review = (await store.presets()).find(p => p.default?.key === 'review')!
        const changed = await store.updatePreset(review.id, {name: 'Review, strictly', text: 'Block on any bug.', icon: null}, me)
        expect(changed.default).toEqual({key: 'review', changed: true})
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
