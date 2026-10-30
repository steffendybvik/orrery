import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {getHeader, readBody, setResponseStatus} from 'h3'
import type {Project} from '#shared/roadmap'
import BulkBar from '~/components/BulkBar.vue'

// Chain in order (ORR-601): the ticked issues, in order, each come to depend on the one before it, keeping what they
// depended on already, one call each as the owner; one refused is listed and stays ticked.
let sent: {path: string, actor?: string, body: unknown}[] = []
let refusing = ''
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const record = (path: string) => async (event: H3Event) => {
    if (refusing === path) {
        setResponseStatus(event, 400)
        return {message: 'That would make a loop'}
    }
    sent.push({path, actor: getHeader(event, 'orrery-actor'), body: await readBody(event)})
    return {}
}
for (const id of ['GRE-1', 'GRE-2', 'GRE-3']) registerEndpoint(`/api/projects/greenhouse/issues/${id}`, {method: 'PATCH', handler: record(id)})
registerEndpoint('/api/projects/pantry/issues/PAN-4', {method: 'PATCH', handler: record('PAN-4')})

const issue = (id: string, more: Record<string, unknown> = {}) => ({id, title: id, aliases: [], labels: [], tasks: [], column: 'todo', kind: 'todo', ...more})
const GREENHOUSE = {id: 'greenhouse', name: 'Greenhouse', key: 'GRE', releases: [], board: {chunks: [{id: '', title: 'No chunk', tasks: [
    issue('GRE-1'), issue('GRE-2', {depends_on: ['GRE-9']}), issue('GRE-3'),
]}]}} as unknown as Project
const PANTRY = {id: 'pantry', name: 'Pantry', key: 'PAN', releases: [], board: {chunks: [{id: '', title: 'No chunk', tasks: [issue('PAN-4')]}]}} as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    refusing = ''
    useRoadmaps().projects.value = [GREENHOUSE, PANTRY]
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useSelection().clear()
})

async function mount(ticked: string[]) {
    // Off the page (no rows here), they're chained in the order they were ticked.
    useSelection().selected.value = ticked
    const wrapper = await mountSuspended(BulkBar, {route: '/p/greenhouse'})
    mounted.push(wrapper)
    const chain = () => wrapper.findAll('button').find(b => b.text() === 'Chain in order')
    return {wrapper, chain}
}

describe('BulkBar, Chain in order', () => {
    it("links them in order, each keeping what it depended on, as the owner", async () => {
        const {wrapper, chain} = await mount(['greenhouse/GRE-1', 'greenhouse/GRE-2', 'greenhouse/GRE-3'])
        await chain()!.trigger('click')
        await vi.waitFor(() => expect(wrapper.find('[role=status]').text()).toBe('Chained 3 issues'))
        expect(sent).toEqual([
            {path: 'GRE-2', actor: 'skoll', body: {depends_on: ['GRE-9', 'GRE-1']}},
            {path: 'GRE-3', actor: 'skoll', body: {depends_on: ['GRE-2']}},
        ])
        expect(useSelection().selected.value).toEqual([])
    })

    it('names one in another project by its project, and lists a refusal', async () => {
        const {wrapper, chain} = await mount(['greenhouse/GRE-3', 'pantry/PAN-4', 'greenhouse/GRE-1'])
        refusing = 'GRE-1'
        await chain()!.trigger('click')
        await vi.waitFor(() => expect(wrapper.find('[role=status]').text()).toBe('Chained 1 of 2 links'))
        expect(sent).toEqual([{path: 'PAN-4', actor: 'skoll', body: {depends_on: ['greenhouse/GRE-3']}}])
        expect(wrapper.text()).toContain('GRE-1: That would make a loop')
        expect(useSelection().selected.value).toEqual(['pantry/PAN-4', 'greenhouse/GRE-1'])
    })

    it("isn't offered for one issue", async () => {
        const {chain} = await mount(['greenhouse/GRE-1'])
        expect(chain()).toBeUndefined()
    })
})
