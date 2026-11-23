import {beforeEach, describe, expect, it, vi} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Project, Schedule, Session} from '#shared/roadmap'
import AppSidebar from '~/components/AppSidebar.vue'

// The sidebar: what each count counts, what Advanced adds, a project's pages folding away, and the sessions at the bottom,
// those waiting on the owner first. Dragging and the keys that move a project are in the browser specs.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
let pulls = {repos: [], needs: 0, open: 0}
registerEndpoint('/api/pulls', () => pulls)
// What each listening session is on, for its second line (ORR-484).
let work: Record<string, unknown> = {}
registerEndpoint('/api/sessions/work', () => work)

const project = (id: string, name: string, more: Record<string, unknown> = {}) =>
    ({id, name, key: id.slice(0, 3).toUpperCase(), releases: [], docs: [], release_mode: 'none', board: {milestones: [], kinds: {}}, ...more}) as unknown as Project
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
    useState('project-order').value = []
    useAppSettings().settings.value.starred = []
    useAppSettings().settings.value.hidden = []
    pulls = {repos: [], needs: 0, open: 0}
    work = {}
    localStorage.clear()
})

const mount = () => mountSuspended(AppSidebar)
type Wrapper = Awaited<ReturnType<typeof mount>>
const link = (wrapper: Wrapper, to: string) => wrapper.findAll('a').find(a => a.attributes('href') === `/w/default${to}`)

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

    it('shows Events and Pull requests only with Advanced on, each on its own row, and never Context', async () => {
        const off = await mount()
        for (const to of ['/events', '/context', '/pulls']) expect(link(off, to)).toBeUndefined()
        off.unmount()

        useAppSettings().settings.value.advanced = true
        const on = await mount()
        for (const to of ['/events', '/pulls']) expect(link(on, to)).toBeDefined()
        // Context is reached from App settings → Advanced, a running session's card and ⌘K instead (#1389).
        expect(link(on, '/context')).toBeUndefined()
        // No row folds them away (ORR-973 took ORR-967's back out).
        expect(on.findAll('button').some(b => b.text() === 'Advanced')).toBe(false)
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
        const pages = () => wrapper.findAll('a').filter(a => a.attributes('href')?.startsWith('/w/default/shop/')).length
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
        // The nav keeps its own Sessions row with the count (ORR-972), beside the panel's heading at the foot.
        expect(wrapper.find('nav').findAll('a').find(a => a.attributes('href') === '/w/default/sessions')!.text()).toBe('Sessions3')
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

    it('folds hidden projects away under Hidden, and stars the starred', async () => {
        useAppSettings().settings.value.hidden = ['blog']
        useAppSettings().settings.value.starred = ['shop']
        const wrapper = await mount()
        const fold = wrapper.find('[data-testid="sidebar-hidden"]')
        expect(fold.text()).toBe('Hidden1')
        expect(link(wrapper, '/blog')).toBeUndefined()
        expect(wrapper.find('[aria-label="Starred"]').exists()).toBe(true)
        await fold.trigger('click')
        expect(fold.attributes('aria-expanded')).toBe('true')
        expect(link(wrapper, '/blog')!.text()).toBe('Blog')
    })

    it('rearranges the projects by dragging one onto another', async () => {
        const wrapper = await mount()
        const names = () => wrapper.find('nav').findAll('a[draggable="true"]').map(a => a.find('span.flex-1').text())
        expect(names()).toEqual(['Blog', 'Shop'])
        const rows = () => wrapper.find('nav').findAll('a[draggable="true"]').map(a => a.element.closest('.relative.flex') as HTMLElement)
        // A drag over that isn't one of the projects' is let be.
        rows()[1]!.dispatchEvent(new Event('dragover', {bubbles: true}))
        await wrapper.find('nav').findAll('a[draggable="true"]')[0]!.trigger('dragstart')
        // The lower half of Shop's row: it lands after it, and a line shows where.
        const over = new Event('dragover', {bubbles: true, cancelable: true})
        Object.assign(over, {clientY: 10})
        rows()[1]!.dispatchEvent(over)
        await nextTick()
        expect(over.defaultPrevented).toBe(true)
        expect(rows()[1]!.querySelector('.-bottom-1\\.5')).not.toBeNull()
        rows()[1]!.dispatchEvent(new Event('drop', {bubbles: true, cancelable: true}))
        await nextTick()
        expect(names()).toEqual(['Shop', 'Blog'])
        expect(JSON.parse(localStorage.getItem('orrery-project-order')!)).toEqual(['shop', 'blog'])
        // A drop with nothing dragged changes nothing.
        rows()[0]!.dispatchEvent(new Event('drop', {bubbles: true, cancelable: true}))
        await wrapper.find('nav').findAll('a[draggable="true"]')[0]!.trigger('dragend')
        expect(names()).toEqual(['Shop', 'Blog'])
    })

    it('moves a project with ⌥↑ and ⌥↓, and opens and folds its pages with → and ←', async () => {
        const wrapper = await mount()
        const names = () => wrapper.find('nav').findAll('a[draggable="true"]').map(a => a.find('span.flex-1').text())
        const blog = () => wrapper.find('nav').findAll('a[draggable="true"]').find(a => a.text().startsWith('Blog'))!
        await blog().trigger('keydown', {key: 'ArrowDown', altKey: true})
        expect(names()).toEqual(['Shop', 'Blog'])
        await blog().trigger('keydown', {key: 'ArrowUp', altKey: true})
        expect(names()).toEqual(['Blog', 'Shop'])
        await blog().trigger('keydown', {key: 'ArrowLeft'})
        expect(blog().attributes('aria-expanded')).toBe('false')
        await blog().trigger('keydown', {key: 'ArrowRight'})
        expect(blog().attributes('aria-expanded')).toBe('true')
    })

    it('says where a session spans several projects, why one was cut off, and the issue it is on', async () => {
        useRoadmaps().projects.value = [project('shop', 'Shop'), project('blog', 'Blog'), project('cafe', 'Cafe')]
        useRoadmaps().sessions.value = {
            shop: [session('everywhere', 'shop', 'working', {also: ['blog', 'cafe']})],
            blog: [session('pair', 'blog', 'working', {also: ['cafe']})],
            cafe: [session('limited', 'cafe', 'idle', {cut_off: {kind: 'usage', text: 'Out of usage until 3pm'}} as never)],
        }
        work = {shop: {everywhere: {issues: [{id: 'SHO-2', title: 'Restock the jars'}, {id: 'SHO-1', title: 'Count the jars'}]}}}
        const wrapper = await mount()
        const panel = wrapper.find('[data-testid="sidebar-sessions"]')
        const row = (name: string) => panel.findAll('a').find(a => a.text().includes(name))!
        expect(row('everywhere').text()).toContain('All projects')
        expect(row('everywhere').attributes('title')).toContain('Shop, Blog, Cafe')
        expect(row('pair').text()).toContain('2 projects')
        expect(row('limited').find('[title="Out of usage until 3pm"]').exists()).toBe(true)
        await vi.waitFor(() => expect(panel.find('a[title="SHO-2: Restock the jars"]').exists()).toBe(true))
        expect(panel.find('a[title="SHO-2: Restock the jars"]').text()).toContain('+1')
    })

    it('folds the sessions away, and remembers it', async () => {
        useRoadmaps().sessions.value = {shop: [session('jars', 'shop', 'working')]}
        const wrapper = await mount()
        await wrapper.find('[data-testid="sidebar-sessions-fold"]').trigger('click')
        expect(wrapper.find('[data-testid="sidebar-sessions"]').text()).not.toContain('jars')
        expect(localStorage.getItem('orrery-sidebar-sessions')).toBe('folded')
        wrapper.unmount()

        const again = await mount()
        expect(again.find('[data-testid="sidebar-sessions-resize"]').exists()).toBe(false)
        await again.find('[data-testid="sidebar-sessions-fold"]').trigger('click')
        expect(again.text()).toContain('jars')
        expect(localStorage.getItem('orrery-sidebar-sessions')).toBeNull()
    })

    it('resizes the sessions by its edge, by keys and by dragging, and puts it back on a double-click', async () => {
        useRoadmaps().sessions.value = {shop: [session('jars', 'shop', 'working')]}
        const wrapper = await mount()
        const edge = wrapper.find('[data-testid="sidebar-sessions-resize"]')
        expect(edge.attributes('aria-valuenow')).toBe('224')
        // Laid out with no room, it can only be as short as it goes.
        await edge.trigger('keydown', {key: 'ArrowUp'})
        expect(edge.attributes('aria-valuenow')).toBe('64')
        await edge.trigger('keydown', {key: 'a'})
        expect(edge.attributes('aria-valuenow')).toBe('64')
        await edge.trigger('dblclick')
        expect(edge.attributes('aria-valuenow')).toBe('224')
        const capture = vi.fn()
        Object.assign(edge.element, {setPointerCapture: capture, releasePointerCapture: capture})
        await edge.trigger('pointerdown', {button: 2})
        expect(document.documentElement.classList.contains('cursor-row-resize')).toBe(false)
        await edge.trigger('pointerdown', {button: 0, clientY: 300, pointerId: 1})
        expect(document.documentElement.classList.contains('cursor-row-resize')).toBe(true)
        await edge.trigger('pointermove', {clientY: 200, pointerId: 1})
        expect(edge.attributes('aria-valuenow')).toBe('64')
        await edge.trigger('pointerup', {pointerId: 1})
        await edge.trigger('pointerup', {pointerId: 1})
        expect(capture).toHaveBeenCalledTimes(2)
        expect(document.documentElement.classList.contains('cursor-row-resize')).toBe(false)
    })

    it('pops the sessions out to float over the page, and back', async () => {
        useRoadmaps().sessions.value = {shop: [session('jars', 'shop', 'working')]}
        const wrapper = await mount()
        await wrapper.find('[aria-label="Pop out the sessions"]').trigger('click')
        const floating = document.body.querySelector('[role="region"][aria-label="Sessions"]') as HTMLElement
        expect(floating).not.toBeNull()
        // Esc folds it away while it floats.
        floating.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
        await nextTick()
        expect(floating.querySelector('[data-testid="sidebar-sessions-fold"]')!.getAttribute('aria-expanded')).toBe('false')
        ;(floating.querySelector('[aria-label="Back to the sidebar"]') as HTMLElement).click()
        await nextTick()
        expect(document.body.querySelector('[role="region"][aria-label="Sessions"]')).toBeNull()
        expect(wrapper.find('[aria-label="Pop out the sessions"]').exists()).toBe(true)
        wrapper.unmount()
    })

    it("counts the pull requests that need someone, or else those open, with Advanced on", async () => {
        useAppSettings().settings.value.advanced = true
        pulls = {repos: [], needs: 0, open: 4}
        const open = await mount()
        await vi.waitFor(() => expect(link(open, '/pulls')!.text()).toContain('4'))
        open.unmount()

        pulls = {repos: [], needs: 2, open: 4}
        const needs = await mount()
        await vi.waitFor(() => expect(link(needs, '/pulls')!.find('[title="2 need someone: conflicts, failing checks or behind"]').exists()).toBe(true))
    })

    it('asks for the pull requests again every two minutes while the page shows, and stops with Advanced off', async () => {
        vi.useFakeTimers()
        try {
            useAppSettings().settings.value.advanced = true
            const wrapper = await mount()
            pulls = {repos: [], needs: 0, open: 7}
            await vi.advanceTimersByTimeAsync(120_000)
            await vi.waitFor(() => expect(link(wrapper, '/pulls')!.text()).toContain('7'))
            useAppSettings().settings.value.advanced = false
            await nextTick()
            pulls = {repos: [], needs: 0, open: 9}
            await vi.advanceTimersByTimeAsync(120_000)
            expect(useOpenPulls().pulls.value?.open).toBe(7)
            wrapper.unmount()
        } finally {
            vi.useRealTimers()
        }
    })

    it('closes as a drawer once another page opens', async () => {
        useState('sidebar-open').value = true
        await mount()
        await useRouter().push('/w/default/schedules')
        await vi.waitFor(() => expect(useState('sidebar-open').value).toBe(false))
    })
})
