import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {readBody, setResponseStatus} from 'h3'
import type {Preset, Project} from '#shared/roadmap'
import PresetDialog from '~/components/PresetDialog.vue'

// Writing a preset (ORR-866): a new one goes to the orrery's list or a project's, one already made is saved, removed
// or reset to what orrery ships, Add waits for a name and text, and a refused save says why and keeps the dialog.
let calls: {method: string, url: string, body?: unknown}[] = []
let refuse = false
const record = (url: string, method: string) => async (event: H3Event) => {
    if (refuse) {
        setResponseStatus(event, 409)
        return {message: 'A preset called Review is already there'}
    }
    calls.push({method, url, ...method === 'DELETE' ? {} : {body: await readBody(event).catch(() => undefined)}})
    return {}
}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/presets', {method: 'POST', handler: record('/api/presets', 'POST')})
registerEndpoint('/api/projects/shop/presets', {method: 'POST', handler: record('/api/projects/shop/presets', 'POST')})
registerEndpoint('/api/presets/4', {method: 'PATCH', handler: record('/api/presets/4', 'PATCH')})
registerEndpoint('/api/presets/4', {method: 'DELETE', handler: record('/api/presets/4', 'DELETE')})
registerEndpoint('/api/presets/4/reset', {method: 'POST', handler: record('/api/presets/4/reset', 'POST')})

const preset = (over: Partial<Preset> = {}): Preset => ({
    id: 4, project: null, name: 'Review', text: 'Read the diff.', icon: null, color: null,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over,
})
const shop = {id: 'shop', name: 'Shop'} as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    calls = []
    refuse = false
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(open: Preset | 'new', project?: Project) {
    const component = await mountSuspended(PresetDialog, {props: {open, ...project ? {project} : {}}, attachTo: document.body})
    mounted.push(component)
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const page = new DOMWrapper(document.body)
    await vi.waitFor(() => expect(page.find('textarea#preset-text').exists()).toBe(true))
    const button = (text: string) => page.findAll('button').find(b => b.text().startsWith(text))
    return {component, page, button, name: page.find('input[aria-label="Preset name"]'), text: page.find('textarea#preset-text')}
}

describe('PresetDialog', () => {
    it('adds a new one to the orrery\'s presets once it has a name and text, and closes', async () => {
        const {component, page, button, name, text} = await mount('new')
        expect(page.text()).toContain('for sessions on any project')
        expect(button('Add preset')!.attributes('disabled')).toBeDefined()
        await name.setValue('  Careful ')
        expect(button('Add preset')!.attributes('disabled')).toBeDefined()
        await text.setValue('Go slow.')
        expect(button('Add preset')!.attributes('disabled')).toBeUndefined()
        await page.find('form').trigger('submit')
        await vi.waitFor(() => expect(component.emitted('close')).toHaveLength(1))
        expect(component.emitted('saved')).toHaveLength(1)
        expect(calls).toEqual([{method: 'POST', url: '/api/presets', body: {name: 'Careful', text: 'Go slow.', icon: null, color: null}}])
    })

    it('adds one to a project\'s own presets from its settings', async () => {
        const {page, name, text} = await mount('new', shop)
        expect(page.text()).toContain('for sessions on Shop')
        await name.setValue('Ship')
        await text.setValue('Run the e2e suite.')
        await page.find('form').trigger('submit')
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        expect(calls[0]).toMatchObject({method: 'POST', url: '/api/projects/shop/presets'})
    })

    it('opens one already made with its words, and saves the change to it', async () => {
        const {page, button, name, text} = await mount(preset())
        expect((name.element as HTMLInputElement).value).toBe('Review')
        expect((text.element as HTMLTextAreaElement).value).toBe('Read the diff.')
        expect(button('Reset to default')).toBeUndefined()
        await text.setValue('Read the diff, then comment.')
        await page.find('form').trigger('submit')
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        expect(calls[0]).toEqual({method: 'PATCH', url: '/api/presets/4', body: {name: 'Review', text: 'Read the diff, then comment.', icon: null, color: null}})
    })

    it('removes one, and resets one orrery ships once it was changed', async () => {
        const first = await mount(preset())
        await first.button('Remove Review')!.trigger('click')
        await vi.waitFor(() => expect(calls).toEqual([{method: 'DELETE', url: '/api/presets/4'}]))
        first.component.unmount()
        mounted.pop()
        calls = []
        const second = await mount(preset({default: {key: 'review', changed: true}}))
        await second.button('Reset to default')!.trigger('click')
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        expect(calls[0]).toMatchObject({method: 'POST', url: '/api/presets/4/reset'})
    })

    it('picks a badge, and goes back to its initials', async () => {
        const {page, button} = await mount(preset({icon: 'star', color: 'amber'}))
        const badge = page.find('button[aria-label="Badge"]')
        expect(badge.attributes('aria-expanded')).toBe('false')
        await badge.trigger('click')
        expect(badge.attributes('aria-expanded')).toBe('true')
        await button('Use its initials')!.trigger('click')
        expect(button('Use its initials')).toBeUndefined()
        await page.find('form').trigger('submit')
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        expect(calls[0]!.body).toMatchObject({icon: null, color: 'amber'})
    })

    it('says why a save was refused, and stays open', async () => {
        refuse = true
        const {component, page, name, text} = await mount('new')
        await name.setValue('Review')
        await text.setValue('Again.')
        await page.find('form').trigger('submit')
        await vi.waitFor(() => expect(page.text()).toContain('A preset called Review is already there'))
        expect(component.emitted('close')).toBeUndefined()
        expect(component.emitted('saved')).toBeUndefined()
    })
})
