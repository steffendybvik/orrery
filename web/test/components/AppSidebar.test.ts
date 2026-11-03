import {beforeEach, describe, expect, it} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Project, Schedule, Session} from '#shared/roadmap'
import AppSidebar from '~/components/AppSidebar.vue'

// The sidebar: what each count counts, what Advanced adds, a project's pages folding away, and the sessions at the bottom,
// those waiting on the owner first. Dragging and the keys that move a project are in the browser specs.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/pulls', () => ({repos: [], needs: 0}))

const project = (id: string, name: string, more: Record<string, unknown> = {}) =>
    ({id, name, key: id.slice(0, 3).toUpperCase(), releases: [], docs: [], release_mode: 'none', board: {chunks: [], kinds: {}}, ...more}) as unknown as Project
const session = (id: string, projectId: string, state: Session['state'], more: Partial<Session> = {}) =>
    ({id, name: id, project: projectId, state, listening: true, since: '', started_at: '', ...more}) as Session

beforeEach(() => {
    useRoadmaps().projects.value = [project('shop', 'Shop'), project('blog', 'Blog')]
    useRoadmaps().sessions.value = {}
    useRoadmaps().ready.value = true
    useSchedules().byProject.value = {}
    useAppSettings().settings.value.advanced = false
    useState('sidebar-open').value = false
    useState('palette-open').value = false
    useState('new-project').value = false
    localStorage.clear()
})

const mount = () => mountSuspended(AppSidebar)
type Wrapper = Awaited<ReturnType<typeof mount>>
const link = (wrapper: Wrapper, to: string) => wrapper.findAll('a').find(a => a.attributes('href') === to)

describe('AppSidebar', () => {
    it('counts only the schedules still set to run', async () => {
        useSchedules().byProject.value = {
            shop: [{id: 1, enabled: true}, {id: 2, enabled: false}] as Schedule[],
            blog: [{id: 3, enabled: true}] as Schedule[],
        }
        const wrapper = await mount()
        expect(link(wrapper, '/schedules')!.text()).toBe('Schedules2')
    })

    it("counts the releases being prepared, not shipped ones or a project's that shares another's", async () => {
        useRoadmaps().projects.value = [
            project('shop', 'Shop', {release_mode: 'own', releases: [{version: '2'}, {version: '1', shipped_on: '2026-10-01'}]}),
            project('blog', 'Blog', {release_mode: 'shared', releases: [{version: '2'}]}),
        ]
        const wrapper = await mount()
        expect(link(wrapper, '/releases')!.text()).toBe('Releases1')
    })

    it('shows Events, Context and Pull requests only with Advanced on', async () => {
        const off = await mount()
        for (const to of ['/events', '/context', '/pulls']) expect(link(off, to)).toBeUndefined()
        off.unmount()

        useAppSettings().settings.value.advanced = true
        const on = await mount()
        for (const to of ['/events', '/context', '/pulls']) expect(link(on, to)).toBeDefined()
    })

    it('says so with no projects yet, once it has read them, and not before', async () => {
        useRoadmaps().projects.value = []
        useRoadmaps().ready.value = false
        const reading = await mount()
        expect(reading.text()).not.toContain('None yet')
        reading.unmount()

        useRoadmaps().ready.value = true
        const wrapper = await mount()
        expect(wrapper.text()).toContain('None yet: start one with +.')
    })

    it('opens New project and the palette', async () => {
        const wrapper = await mount()
        await wrapper.find('[aria-label="New project"]').trigger('click')
        expect(useState('new-project').value).toBe(true)
        await wrapper.findAll('button').find(b => b.text().includes('Jump to'))!.trigger('click')
        expect(useState('palette-open').value).toBe(true)
    })

    it("folds a project's pages away and opens them again", async () => {
        const wrapper = await mount()
        const pages = () => wrapper.findAll('a').filter(a => a.attributes('href')?.startsWith('/p/shop/')).length
        if (!pages()) await wrapper.find('[aria-label="Open Shop"]').trigger('click')
        expect(pages()).toBeGreaterThan(0)
        await wrapper.find('[aria-label="Fold Shop"]').trigger('click')
        expect(pages()).toBe(0)
        await wrapper.find('[aria-label="Open Shop"]').trigger('click')
        expect(pages()).toBeGreaterThan(0)
    })

    it('folds and opens every project at once', async () => {
        const wrapper = await mount()
        const open = wrapper.find('[aria-label="Open every project"]')
        if (open.exists()) await open.trigger('click')
        await wrapper.find('[aria-label="Fold every project"]').trigger('click')
        expect(wrapper.find('[aria-label="Open Shop"]').exists()).toBe(true)
        expect(wrapper.find('[aria-label="Open Blog"]').exists()).toBe(true)
        await wrapper.find('[aria-label="Open every project"]').trigger('click')
        expect(wrapper.find('[aria-label="Fold Shop"]').exists()).toBe(true)
        expect(wrapper.find('[aria-label="Fold Blog"]').exists()).toBe(true)
    })

    it('lists the sessions with those waiting on the owner first, and counts them', async () => {
        useRoadmaps().sessions.value = {
            shop: [session('jars', 'shop', 'working')],
            blog: [session('shelves', 'blog', 'idle'), session('kitchen', 'blog', 'waiting')],
        }
        const wrapper = await mount()
        expect(link(wrapper, '/sessions')!.text()).toBe('Sessions3')
        const text = wrapper.text()
        expect(text.indexOf('kitchen')).toBeLessThan(text.indexOf('jars'))
        expect(text.indexOf('kitchen')).toBeLessThan(text.indexOf('shelves'))
    })

    it("offers to start a session only where a project lets orrery start them", async () => {
        const none = await mount()
        expect(none.find('[aria-label="Start a session"]').exists()).toBe(false)
        none.unmount()

        useRoadmaps().projects.value = [project('shop', 'Shop', {starts: {limit: 1}})]
        const wrapper = await mount()
        expect(wrapper.find('[aria-label="Start a session"]').exists()).toBe(true)
    })

    it('closes as a drawer from its own button', async () => {
        useState('sidebar-open').value = true
        const wrapper = await mount()
        expect(wrapper.find('aside').classes()).toContain('translate-x-0')
        await wrapper.find('[aria-label="Close the menu"]').trigger('click')
        expect(useState('sidebar-open').value).toBe(false)
        expect(wrapper.find('aside').classes()).toContain('-translate-x-full')
    })
})
