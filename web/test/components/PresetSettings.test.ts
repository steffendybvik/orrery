import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {DEFAULT_PRESETS} from '#shared/presets'
import type {Preset, Project} from '#shared/roadmap'
import PresetSettings from '~/components/PresetSettings.vue'

// Presets, in Sessions → Setup: the orrery's or one project's, each a card that opens it to write, New preset, and
// Restore defaults once one orrery ships was removed (ORR-866).
let orrerys: Preset[] = []
let shops: Preset[] = []
let restored = 0
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/presets/defaults', {method: 'POST', handler: () => {
    restored++
    orrerys = DEFAULT_PRESETS.map((d, i) => preset({id: 100 + i, name: d.name, default: {key: d.key, changed: false}}))
    return {restored: 1}
}})
registerEndpoint('/api/presets', () => orrerys)
registerEndpoint('/api/projects/shop/presets', () => shops)

const preset = (over: Partial<Preset>): Preset => ({
    id: 1, project: null, name: 'Careful', text: 'Go slow.\nAsk first.', icon: null, color: null,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over,
})
const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    restored = 0
})
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}
async function mount(project?: Project) {
    const wrapper = await mountSuspended(PresetSettings, {props: project ? {project} : {}})
    mounted.push(wrapper)
    await settle()
    return wrapper
}

describe('Presets', () => {
    it('shows the orrery\'s, each with its name and first line, and restores the defaults that were removed', async () => {
        const [first, ...rest] = DEFAULT_PRESETS
        orrerys = [preset({id: 1, name: first!.name, default: {key: first!.key, changed: false}}), preset({id: 2})]
        const wrapper = await mount()
        const cards = wrapper.findAll('button[aria-label^="Edit "]')
        expect(cards.map(c => c.attributes('aria-label'))).toEqual([`Edit ${first!.name}`, 'Edit Careful'])
        expect(cards[1]!.text()).toContain('Go slow.')
        expect(cards[1]!.text()).not.toContain('Ask first.')
        expect(wrapper.text()).toContain(`${rest.map(d => d.name).join(', ')} were removed.`)
        await wrapper.findAll('button').find(b => b.text() === 'Restore defaults')!.trigger('click')
        await settle()
        expect(restored).toBe(1)
        expect(wrapper.text()).not.toContain('removed.')
        expect(wrapper.findAll('button[aria-label^="Edit "]')).toHaveLength(DEFAULT_PRESETS.length)
    })

    it('shows only a project\'s own on its settings, with no defaults to restore', async () => {
        shops = [preset({id: 5, project: 'shop', name: 'Till rules'}), preset({id: 6, project: null, name: 'Leaked'})]
        const wrapper = await mount({id: 'shop', name: 'Shop'} as Project)
        expect(wrapper.findAll('button[aria-label^="Edit "]').map(c => c.attributes('aria-label'))).toEqual(['Edit Till rules'])
        expect(wrapper.text()).not.toContain('Restore defaults')
        expect(wrapper.text()).toContain('New preset')
    })
})
