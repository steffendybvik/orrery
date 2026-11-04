import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {readBody, setResponseStatus} from 'h3'
import type {Instruction} from '#shared/prompt'
import {DEFAULT_FOCUS_PROMPT} from '#shared/prompt'
import type {Project} from '#shared/roadmap'
import FocusPrompts from '~/components/FocusPrompts.vue'

// What a session hears when asked to focus, in Sessions → Setup (ORR-866): the two templates, edited, previewed and
// reset, and the standing instructions added, renamed, ticked and removed. The orrery's go to the settings; a project's
// to the project, which can switch off one of the orrery's for itself.
let sent: {path: string, body: Record<string, unknown>}[] = []
let failing = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const record = (path: string) => async (event: H3Event) => {
    if (failing) {
        setResponseStatus(event, 400)
        return {message: 'That template is too long'}
    }
    const body = await readBody(event)
    sent.push({path, body})
    return path === 'settings' ? {...useAppSettings().settings.value, ...body} : {}
}
registerEndpoint('/api/settings', {method: 'PATCH', handler: record('settings')})
registerEndpoint('/api/projects/shop', {method: 'PATCH', handler: record('projects/shop')})

const line = (id: number, text: string, on = true) => ({id, text, on}) as Instruction
const SHOP = {id: 'shop', name: 'Shop', key: 'SHO', instructions: [line(5, 'Run the shop tests')], muted: [1]} as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    failing = false
    const {settings} = useAppSettings()
    settings.value = {...settings.value, focus_prompt: null, milestone_prompt: null, instructions: [line(1, 'Commit often'), line(2, 'Ask before deleting', false)]}
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}
async function mount(project?: Project) {
    const wrapper = await mountSuspended(FocusPrompts, {props: project ? {project} : {}})
    mounted.push(wrapper as VueWrapper)
    const button = (text: string) => wrapper.findAll('button').find(b => b.text() === text)
    return {wrapper, button}
}

describe("the orrery's focus templates", () => {
    it('follows the default until edited, and saves what was written, trimmed, once done', async () => {
        const {wrapper, button} = await mount()
        expect(wrapper.text()).toContain('the default')
        await wrapper.find('button[aria-label="Edit Focus on an issue"]').trigger('click')
        const box = wrapper.find('textarea[aria-label="Focus on an issue"]')
        expect(box.attributes('placeholder')).toBe(DEFAULT_FOCUS_PROMPT)
        await box.setValue('  Work on {issue}.  ')
        await button('Done')!.trigger('click')
        await settle()
        expect(sent).toEqual([{path: 'settings', body: {focus_prompt: 'Work on {issue}.'}}])
        expect(wrapper.text()).toContain('your own')
    })

    it('saves nothing when the text is as it was', async () => {
        const {wrapper, button} = await mount()
        await wrapper.find('button[aria-label="Edit Focus on an issue"]').trigger('click')
        await button('Done')!.trigger('click')
        await settle()
        expect(sent).toEqual([])
    })

    it('previews it as a session would hear it, with the ticked instructions only', async () => {
        useAppSettings().settings.value.focus_prompt = 'Work on {issue}: {title}.'
        const {wrapper} = await mount()
        await wrapper.findAll('button').filter(b => b.text() === 'Preview')[0]!.trigger('click')
        const preview = wrapper.find('pre').text()
        expect(preview).toContain('Work on GRE-42: Scale a recipe by servings.')
        expect(preview).toContain('Commit often')
        expect(preview).not.toContain('Ask before deleting')
    })

    it('resets one made its own to the default', async () => {
        useAppSettings().settings.value.focus_prompt = 'Mine'
        const {wrapper, button} = await mount()
        await wrapper.find('button[aria-label="Edit Focus on an issue"]').trigger('click')
        await button('Reset to the default')!.trigger('click')
        await settle()
        expect(sent).toEqual([{path: 'settings', body: {focus_prompt: null}}])
    })

    it('says why a save was refused', async () => {
        failing = true
        const {wrapper, button} = await mount()
        await wrapper.find('button[aria-label="Edit Focus on an issue"]').trigger('click')
        await wrapper.find('textarea').setValue('Too long')
        await button('Done')!.trigger('click')
        await settle()
        expect(wrapper.text()).toContain('That template is too long')
    })
})

describe("the orrery's standing instructions", () => {
    it('adds one, ticked, and keeps the rest', async () => {
        const {wrapper} = await mount()
        await wrapper.find('input[aria-label="New instruction"]').setValue(' Write tests first ')
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(sent.at(-1)!.body.instructions).toEqual([line(1, 'Commit often'), line(2, 'Ask before deleting', false), {text: 'Write tests first', on: true}])
        expect((wrapper.find('input[aria-label="New instruction"]').element as HTMLInputElement).value).toBe('')
    })

    it('renames one on leaving its field, and puts back an emptied one unsaved', async () => {
        const {wrapper} = await mount()
        const first = wrapper.findAll('input[aria-label="Instruction"]')[0]!
        await first.setValue('Commit when it works')
        await first.trigger('blur')
        await settle()
        expect(sent.at(-1)!.body.instructions).toEqual([line(1, 'Commit when it works'), line(2, 'Ask before deleting', false)])
        sent = []
        const second = wrapper.findAll('input[aria-label="Instruction"]')[1]!
        await second.setValue('  ')
        await second.trigger('blur')
        await settle()
        expect(sent).toEqual([])
        expect((second.element as HTMLInputElement).value).toBe('Ask before deleting')
    })

    it('ticks one by default or not, and removes one', async () => {
        const {wrapper} = await mount()
        await wrapper.find('input[aria-label="Tick “Ask before deleting” by default"]').trigger('change')
        await settle()
        expect(sent.at(-1)!.body.instructions).toEqual([line(1, 'Commit often'), line(2, 'Ask before deleting', true)])
        await wrapper.find('button[aria-label="Remove “Commit often”"]').trigger('click')
        await settle()
        expect((sent.at(-1)!.body.instructions as Instruction[]).map(l => l.id)).toEqual([2])
    })
})

describe("a project's own", () => {
    it("follows the orrery's template until it has its own, and saves to the project", async () => {
        const {wrapper, button} = await mount(SHOP)
        expect(wrapper.text()).toContain("the orrery's")
        await wrapper.find('button[aria-label="Edit Focus on an issue"]').trigger('click')
        await wrapper.find('textarea').setValue('Shop: {issue}')
        await button('Done')!.trigger('click')
        await settle()
        expect(sent).toEqual([{path: 'projects/shop', body: {focus_prompt: 'Shop: {issue}'}}])
    })

    it("lists the orrery's instructions to switch off for it, and keeps its own apart", async () => {
        const {wrapper} = await mount(SHOP)
        expect(wrapper.findAll('input[aria-label="Instruction"]').map(i => (i.element as HTMLInputElement).value)).toEqual(['Run the shop tests'])
        const commit = wrapper.find('input[aria-label="Use “Commit often” in Shop"]')
        expect((commit.element as HTMLInputElement).checked).toBe(false)
        await commit.trigger('change')
        await settle()
        expect(sent).toEqual([{path: 'projects/shop', body: {muted: []}}])
        await wrapper.find('input[aria-label="Use “Ask before deleting” in Shop"]').trigger('change')
        await settle()
        expect(sent.at(-1)).toEqual({path: 'projects/shop', body: {muted: [1, 2]}})
        expect(wrapper.text()).toContain('unticked by default')
    })
})
