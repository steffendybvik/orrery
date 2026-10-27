import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {getHeader, getMethod, readBody, setResponseStatus} from 'h3'
import type {Project} from '#shared/roadmap'
import IssueMenu from '~/components/IssueMenu.vue'

// Right-clicking an issue: what each action sends and as whom, the chunk list, asking the sessions, removing only
// once asked again, and an error keeping it open.
let sent: {method: string, path: string, actor?: string, body?: unknown}[] = []
let failing = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const record = (path: string) => async (event: H3Event) => {
    if (failing) {
        setResponseStatus(event, 409)
        return {message: 'LAR-1 has moved on'}
    }
    const method = getMethod(event)
    sent.push({method, path, actor: getHeader(event, 'orrery-actor'), ...method === 'DELETE' ? {} : {body: await readBody(event)}})
    return {}
}
for (const method of ['PATCH', 'DELETE'] as const) registerEndpoint('/api/projects/larder/issues/LAR-1', {method, handler: record('LAR-1')})
registerEndpoint('/api/projects/larder/issues/LAR-1/focus', {method: 'POST', handler: record('LAR-1/focus')})

const issue = (id: string, title: string, more: Record<string, unknown> = {}) => ({id, title, aliases: [], labels: [], tasks: [], column: 'todo', kind: 'todo', ...more})
const LARDER = {
    id: 'larder', name: 'Larder', key: 'LAR',
    board: {chunks: [
        {id: 'stock', title: 'Stock', tasks: [issue('LAR-1', 'Label the jars', {priority: 'P2'})]},
        {id: 'shelves', title: 'Shelves', tasks: []},
        {id: '', title: 'No chunk', tasks: []},
    ]},
} as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    failing = false
    useRoadmaps().projects.value = [LARDER]
    useRoadmaps().sessions.value = {larder: [{listening: true}, {listening: true}, {listening: false}] as never}
    useAppSettings().settings.value.statuses = [
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
        {id: 'done', name: 'Done', kind: 'done', color: 'green'},
    ] as never
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useIssueMenu().close()
})

async function mount() {
    useIssueMenu().target.value = {project: 'larder', issue: 'LAR-1', x: 40, y: 40}
    const wrapper = await mountSuspended(IssueMenu, {global: {stubs: {teleport: true}}})
    mounted.push(wrapper)
    const button = (text: string) => wrapper.findAll('button').find(b => b.text().startsWith(text) || b.attributes('aria-label') === text)!
    const closed = () => vi.waitFor(() => expect(useIssueMenu().target.value).toBeNull())
    return {wrapper, button, closed}
}

describe('IssueMenu', () => {
    it('moves it and sets its priority as the owner, closing once saved', async () => {
        const {wrapper, button, closed} = await mount()
        expect(wrapper.find('[role=menu]').attributes('aria-label')).toBe('Actions for LAR-1')
        await button('Move to Done').trigger('click')
        await closed()
        expect(sent).toEqual([{method: 'PATCH', path: 'LAR-1', actor: 'skoll', body: {status: 'done'}}])

        const again = await mount()
        await again.button('Priority P1').trigger('click')
        await again.closed()
        expect(sent[1]).toEqual({method: 'PATCH', path: 'LAR-1', actor: 'skoll', body: {priority: 'P1'}})
    })

    it('lists the chunks to move it to, and No chunk takes it out', async () => {
        const {wrapper, button, closed} = await mount()
        expect(button('Move to chunk').text()).toContain('Stock')
        await button('Move to chunk').trigger('click')
        expect(wrapper.findAll('button').map(b => b.text())).toEqual(['‹ Back', 'No chunk', 'Stock', 'Shelves'])
        await button('No chunk').trigger('click')
        await closed()
        expect(sent).toEqual([{method: 'PATCH', path: 'LAR-1', actor: 'skoll', body: {chunk: null}}])
    })

    it('asks one listening session, or all of them, and says which', async () => {
        const {wrapper, button} = await mount()
        await button('Ask a session to focus on it').trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Sent to one session, the first free'))
        await button('Ask all 2 sessions to focus on it').trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Sent to all 2 sessions'))
        expect(sent.map(s => s.body)).toEqual([{}, {session: '*'}])
        expect(useIssueMenu().target.value).not.toBeNull()
    })

    it('removes it only once asked again', async () => {
        const {wrapper, button, closed} = await mount()
        await button('Remove…').trigger('click')
        expect(wrapper.text()).toContain('Remove LAR-1, with its comments?')
        await button('Cancel').trigger('click')
        expect(sent).toEqual([])
        await button('Remove…').trigger('click')
        await wrapper.findAll('button').filter(b => b.text() === 'Remove').at(-1)!.trigger('click')
        await closed()
        expect(sent).toEqual([{method: 'DELETE', path: 'LAR-1', actor: 'skoll'}])
    })

    it('stays open with why when a change fails', async () => {
        failing = true
        const {wrapper, button} = await mount()
        await button('Move to Done').trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('LAR-1 has moved on'))
        expect(useIssueMenu().target.value).not.toBeNull()
    })

    it('closes on Esc', async () => {
        const {wrapper, closed} = await mount()
        await wrapper.find('[role=menu]').trigger('keydown', {key: 'Escape'})
        await closed()
    })
})
