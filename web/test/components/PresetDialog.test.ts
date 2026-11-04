import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper, flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {getMethod, readBody, setResponseStatus} from 'h3'
import type {Preset, Project} from '#shared/roadmap'
import PresetDialog from '~/components/PresetDialog.vue'

// Writing a preset in Sessions → Setup (ORR-866): a new one for any project or for one, editing one already made,
// removing it, and putting one orrery ships back as it ships it. A refused save says why and keeps the dialog open.
let sent: {method: string, path: string, body?: unknown}[] = []
let failing = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const record = (path: string) => async (event: H3Event) => {
    if (failing) {
        setResponseStatus(event, 400)
        return {message: 'A preset needs a name'}
    }
    const method = getMethod(event)
    sent.push({method, path, ...method === 'DELETE' ? {} : {body: await readBody(event).catch(() => undefined)}})
    return {}
}
registerEndpoint('/api/presets', {method: 'POST', handler: record('presets')})
registerEndpoint('/api/projects/shop/presets', {method: 'POST', handler: record('projects/shop/presets')})
for (const method of ['PATCH', 'DELETE'] as const) registerEndpoint('/api/presets/7', {method, handler: record('presets/7')})
registerEndpoint('/api/presets/7/reset', {method: 'POST', handler: record('presets/7/reset')})

const CAREFUL: Preset = {id: 7, project: null, name: 'Careful', text: 'Go slow.', icon: null, color: null,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z'}
const SHOP = {id: 'shop', name: 'Shop', key: 'SHO'} as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    failing = false
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}

async function mount(open: Preset | 'new', project?: Project) {
    const component = await mountSuspended(PresetDialog, {props: {open, ...project ? {project} : {}}, attachTo: document.body})
    mounted.push(component as VueWrapper)
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    const button = (text: string) => wrapper.findAll('button').find(b => b.text().startsWith(text))!
    return {component, wrapper, button}
}

describe('PresetDialog', () => {
    it("adds a preset for any project, trimmed, once it has a name and words", async () => {
        const {component, wrapper, button} = await mount('new')
        expect(wrapper.text()).toContain('for sessions on any project')
        expect(button('Add preset').attributes('disabled')).toBeDefined()
        await wrapper.find('input[aria-label="Preset name"]').setValue(' Review ')
        await wrapper.find('textarea').setValue('  Read the diff and comment.  ')
        expect(button('Add preset').attributes('disabled')).toBeUndefined()
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(sent).toEqual([{method: 'POST', path: 'presets', body: {name: 'Review', text: 'Read the diff and comment.', icon: null, color: null}}])
        expect(component.emitted('saved')).toHaveLength(1)
        expect(component.emitted('close')).toHaveLength(1)
    })

    it("adds one to a project's own presets", async () => {
        const {wrapper} = await mount('new', SHOP)
        expect(wrapper.text()).toContain('for sessions on Shop')
        await wrapper.find('input[aria-label="Preset name"]').setValue('E2E')
        await wrapper.find('textarea').setValue('Run the e2e suite.')
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['POST projects/shop/presets'])
    })

    it('edits one already made, and removes it', async () => {
        const {wrapper, button} = await mount(CAREFUL)
        expect((wrapper.find('input[aria-label="Preset name"]').element as HTMLInputElement).value).toBe('Careful')
        expect(button('Reset to default')).toBeUndefined()
        await wrapper.find('textarea').setValue('Go slower.')
        await wrapper.find('form').trigger('submit')
        await settle()
        await button('Remove Careful').trigger('click')
        await settle()
        expect(sent).toEqual([
            {method: 'PATCH', path: 'presets/7', body: {name: 'Careful', text: 'Go slower.', icon: null, color: null}},
            {method: 'DELETE', path: 'presets/7'},
        ])
    })

    it('puts one orrery ships back as it ships it, once changed', async () => {
        const {button} = await mount({...CAREFUL, default: {key: 'careful', changed: true}} as Preset)
        await button('Reset to default').trigger('click')
        await settle()
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['POST presets/7/reset'])
    })

    it('says why a save was refused, and stays open', async () => {
        failing = true
        const {component, wrapper} = await mount(CAREFUL)
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(wrapper.text()).toContain('A preset needs a name')
        expect(component.emitted('close')).toBeUndefined()
    })
})
