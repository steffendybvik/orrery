import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody} from 'h3'
import WelcomeDialog from '~/components/WelcomeDialog.vue'

// The welcome (ORR-1194): a new orrery's first open asks the owner's name, never where to keep the data; then their
// workspace, connecting an agent, and a first project, each skippable, and once done it doesn't come back.
let renamed: unknown[] = []
let workspaces: unknown[] = []
let made: unknown[] = []
registerEndpoint('/api/owner', {method: 'GET', handler: () => ({name: 'agent', display: '', named: false})})
registerEndpoint('/api/owner', {method: 'PUT', handler: async event => {
    const body = await readBody<{name: string}>(event)
    renamed.push(body)
    useOwner().owner.value = {name: 'skoll_fenrisson', display: body.name, named: true}
    return {name: 'skoll_fenrisson', display: body.name, named: true}
}})
/** The workspaces the switcher lists: `Default`, unnamed, unless a test names it. */
let listed: unknown[] = []
registerEndpoint('/api/workspaces', {method: 'GET', handler: () => listed})
registerEndpoint('/api/workspaces/default', {method: 'PATCH', handler: async event => {
    const body = await readBody<{name: string, color: string | null}>(event)
    workspaces.push(body)
    return {id: 'default', name: body.name, color: body.color, role: 'owner'}
}})
registerEndpoint('/api/projects', {method: 'POST', handler: async event => {
    made.push(await readBody(event))
    return {id: 'website'}
}})
registerEndpoint('/api/settings', {method: 'PATCH', handler: () => ({})})

const mounted: VueWrapper[] = []
beforeEach(() => {
    renamed = []
    workspaces = []
    made = []
    listed = [{id: 'default', name: 'Default', color: null, role: 'owner'}]
    localStorage.clear()
    useOwner().owner.value = {name: 'agent', display: '', named: false}
    useState('workspaces-loaded').value = false
    useRoadmaps().ready.value = true
    useRoadmaps().projects.value = []
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount() {
    // As the sidebar's switcher has them by the time the welcome shows.
    await useWorkspaces().load(true)
    mounted.push(await mountSuspended(WelcomeDialog, {attachTo: document.body}))
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    const next = () => wrapper.find('[data-testid="welcome-next"]')
    return {wrapper, next}
}

describe('WelcomeDialog', () => {
    it('asks the name first, never where to keep the data, and won\'t take a blank one or "agent"', async () => {
        const {wrapper, next} = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain("What's your name?"))
        expect(wrapper.text()).not.toMatch(/backup|restore|Postgres|keep its data/i)
        expect(next().attributes('disabled')).toBeDefined()
        await wrapper.find('input[aria-label="Your name"]').setValue('Agent')
        expect(next().attributes('disabled')).toBeDefined()
        expect(renamed).toEqual([])
    })

    it('walks through the name, the workspace, the agent and a first project', async () => {
        const {wrapper} = await mount()
        await vi.waitFor(() => expect(wrapper.find('input[aria-label="Your name"]').exists()).toBe(true))
        await wrapper.find('input[aria-label="Your name"]').setValue('  Sköll Fenrisson ')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(renamed).toEqual([{name: 'Sköll Fenrisson'}]))

        await vi.waitFor(() => expect(wrapper.find('[data-testid="welcome-workspace"]').exists(), wrapper.text()).toBe(true))
        expect((wrapper.find('[data-testid="welcome-workspace"]').element as HTMLInputElement).value).toBe('Personal')
        await wrapper.find('button[aria-label="teal"]').trigger('click')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(workspaces).toEqual([{name: 'Personal', color: 'teal'}]))

        await vi.waitFor(() => expect(wrapper.text()).toContain('Connect your AI agent'))
        expect(wrapper.text()).toContain('Waiting for this computer')
        await wrapper.find('form').trigger('submit')

        await vi.waitFor(() => expect(wrapper.find('[data-testid="welcome-project"]').exists()).toBe(true))
        await wrapper.find('[data-testid="welcome-project"]').setValue('Website')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(made).toEqual([{name: 'Website'}]))
        expect(Object.values(localStorage).some(v => v === 'done') || Object.keys(localStorage).some(k => k.startsWith('orrery-welcome:'))).toBe(true)
    })

    it('goes back to a step answered or skipped, with what was entered there (ORR-1202)', async () => {
        const {wrapper} = await mount()
        const back = () => wrapper.find('[data-testid="welcome-back"]')
        await vi.waitFor(() => expect(wrapper.find('input[aria-label="Your name"]').exists()).toBe(true))
        expect(back().exists()).toBe(false)
        await wrapper.find('input[aria-label="Your name"]').setValue('Sköll')
        await wrapper.find('form').trigger('submit')

        await vi.waitFor(() => expect(wrapper.find('[data-testid="welcome-workspace"]').exists()).toBe(true))
        await wrapper.find('button[aria-label="teal"]').trigger('click')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Connect your AI agent'))
        expect(wrapper.text()).toContain('Step 3 of 4')

        await back().trigger('click')
        await vi.waitFor(() => expect(wrapper.find('[data-testid="welcome-workspace"]').exists()).toBe(true))
        expect(wrapper.text()).toContain('Step 2 of 4')
        expect(wrapper.find('button[aria-label="teal"]').attributes('aria-pressed')).toBe('true')

        await back().trigger('click')
        await vi.waitFor(() => expect(wrapper.find('input[aria-label="Your name"]').exists()).toBe(true))
        expect((wrapper.find('input[aria-label="Your name"]').element as HTMLInputElement).value).toBe('Sköll')
        expect(wrapper.text()).toContain('Step 1 of 4')

        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.find('[data-testid="welcome-workspace"]').exists()).toBe(true))
        await wrapper.findAll('button').find(b => b.text() === 'Skip')!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Connect your AI agent'))
        await back().trigger('click')
        await vi.waitFor(() => expect(wrapper.find('[data-testid="welcome-workspace"]').exists()).toBe(true))
    })

    it("doesn't ask again for the name of a workspace named already, as one made from the switcher is (ORR-1315)", async () => {
        useOwner().owner.value = {name: 'ada', display: 'Ada', named: true}
        listed = [{id: 'default', name: 'Clients', color: 'teal', role: 'owner'}]
        const {wrapper} = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain('Connect your AI agent'))
        expect(wrapper.text()).toContain('Step 1 of 2')
        expect(wrapper.find('[data-testid="welcome-workspace"]').exists()).toBe(false)
    })

    it('doesn\'t open for someone named whose workspace has projects', async () => {
        useOwner().owner.value = {name: 'ada', display: 'Ada', named: true}
        useRoadmaps().projects.value = [{id: 'shop'} as never]
        const {wrapper} = await mount()
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(wrapper.find('[data-testid="welcome-next"]').exists()).toBe(false)
    })
})
