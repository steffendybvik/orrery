import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody, setResponseStatus} from 'h3'
import UsageSettings from '~/components/UsageSettings.vue'

// Usage on App settings → Advanced (ORR-881): counting the owner's use is off until they turn it on, the features
// coldest first, and turned off again it offers to delete what was counted.
type Feature = {feature: string, label: string, last: string | null, days30: number, days90: number}
let usage: {on: boolean, allowed: boolean, features: Feature[]} = {on: false, allowed: true, features: []}
let saved: unknown[] = []
let actors: (string | undefined)[] = []
let deleted = 0
let down = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/usage', {method: 'GET', handler: event => {
    actors.push(getHeader(event, 'orrery-actor'))
    if (down) {
        setResponseStatus(event, 403)
        return {}
    }
    return usage
}})
registerEndpoint('/api/usage', {method: 'DELETE', handler: event => {
    actors.push(getHeader(event, 'orrery-actor'))
    deleted++
    usage = {...usage, features: usage.features.map(f => ({...f, last: null, days30: 0, days90: 0}))}
    return {}
}})
registerEndpoint('/api/settings', {method: 'PATCH', handler: async event => {
    const change = await readBody<{count_use: boolean}>(event)
    saved.push(change)
    if (down) {
        setResponseStatus(event, 500)
        return {}
    }
    usage = {...usage, on: change.count_use}
    return {...useAppSettings().settings.value, ...change}
}})

const features: Feature[] = [
    {feature: 'board:drag', label: 'Dragging a card', last: null, days30: 0, days90: 0},
    {feature: 'search', label: 'Search', last: '2026-11-20', days30: 4, days90: 9},
]
const mounted: VueWrapper[] = []
beforeEach(() => {
    usage = {on: false, allowed: true, features: []}
    saved = []
    actors = []
    deleted = 0
    down = false
    useOwner().owner.value = {name: 'skoll', display: 'Sköll', named: true}
    useAppSettings().settings.value.count_use = false
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount() {
    const wrapper = await mountSuspended(UsageSettings, {attachTo: document.body})
    mounted.push(wrapper)
    await vi.waitFor(() => expect(actors.length).toBeGreaterThan(0))
    return wrapper
}
const box = (wrapper: VueWrapper) => wrapper.get('input[type="checkbox"]')
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(b => b.text() === text)

describe('UsageSettings', () => {
    it('shows nothing to anyone but the owner', async () => {
        down = true
        const wrapper = await mount()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(wrapper.text()).toBe('')
    })

    it("says so when the server counts no one's use", async () => {
        usage = {on: false, allowed: false, features: []}
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain('ORRERY_USAGE=off'))
        expect(wrapper.find('input').exists()).toBe(false)
    })

    it('is off and shows no table until turned on, as the owner, then lists the features', async () => {
        usage = {on: false, allowed: true, features: features.map(f => ({...f, last: null}))}
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain('Count what I use'))
        expect(wrapper.find('table').exists()).toBe(false)
        await box(wrapper).setValue(true)
        // The table shows at once, as the setting does; the save follows.
        expect(wrapper.find('table').exists()).toBe(true)
        await vi.waitFor(() => expect(saved).toEqual([{count_use: true}]))
        expect(actors.every(a => a === 'skoll')).toBe(true)
        const rows = wrapper.findAll('tbody tr')
        expect(rows.map(r => r.attributes('data-feature'))).toEqual(['board:drag', 'search'])
        expect(rows[0]!.text()).toContain('Dragging a cardboard')
        expect(rows[0]!.text()).toContain('never')
        expect(rows[0]!.findAll('td')[3]!.classes()).toContain('text-amber-800')
        expect(rows[1]!.text()).toContain('Search')
    })

    it('shows what was counted while off, the last use of each', async () => {
        usage = {on: false, allowed: true, features}
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.find('table').exists()).toBe(true))
        expect(wrapper.get('tr[data-feature="search"]').text()).toContain('2026-11-20')
    })

    it('turned off with counts kept, offers to delete them, or to keep them', async () => {
        usage = {on: true, allowed: true, features}
        useAppSettings().settings.value.count_use = true
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.find('table').exists()).toBe(true))
        await box(wrapper).setValue(false)
        await vi.waitFor(() => expect(wrapper.text()).toContain("Counting is off. Keep what's been counted, or delete it?"))
        // What was counted still shows while it's kept.
        expect(wrapper.find('table').exists()).toBe(true)
        await button(wrapper, 'Keep them')!.trigger('click')
        expect(wrapper.text()).not.toContain('Counting is off.')
        expect(deleted).toBe(0)

        // The box waits while a save is on its way.
        await box(wrapper).setValue(true)
        await vi.waitFor(() => expect(box(wrapper).attributes('disabled')).toBeUndefined())
        await box(wrapper).setValue(false)
        await vi.waitFor(() => expect(button(wrapper, 'Delete the counts')).toBeDefined())
        await button(wrapper, 'Delete the counts')!.trigger('click')
        await vi.waitFor(() => expect(wrapper.find('table').exists()).toBe(false))
        expect(deleted).toBe(1)
        expect(wrapper.text()).not.toContain('Counting is off.')
    })

    it('offers no delete when nothing was counted, and says why a save failed', async () => {
        usage = {on: true, allowed: true, features: [features[0]!]}
        useAppSettings().settings.value.count_use = true
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.find('input').exists()).toBe(true))
        await box(wrapper).setValue(false)
        await vi.waitFor(() => expect(saved).toHaveLength(1))
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(wrapper.text()).not.toContain('Counting is off.')
        down = true
        await box(wrapper).setValue(true)
        await vi.waitFor(() => expect(wrapper.text()).toContain("Couldn't save it. Is orrery running?"))
    })
})
