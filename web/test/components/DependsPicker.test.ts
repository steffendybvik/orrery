import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {nextTick} from 'vue'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody, setResponseStatus} from 'h3'
import type {Chunk, Issue, Project} from '#shared/roadmap'
import DependsPicker from '~/components/DependsPicker.vue'
import IssueProperties from '~/components/IssueProperties.vue'

// The issues one depends on (ORR-601): picked from its own project's and others', by id or title, never itself; on the
// issue's page each saves the whole list, a refusal (a loop) says why, and the ones it blocks show read the other way.
let sent: {actor?: string, body: unknown}[] = []
let refusing = ''
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/greenhouse/issues/GRE-2', {method: 'PATCH', handler: async event => {
    if (refusing) {
        setResponseStatus(event, 400)
        return {message: refusing}
    }
    sent.push({actor: getHeader(event, 'orrery-actor'), body: await readBody(event)})
    return {}
}})

const issue = (id: string, title: string, more: Record<string, unknown> = {}) => ({id, title, aliases: [], labels: [], external: [], tasks: [], column: 'todo', kind: 'todo', kinds: {done: 0}, created_by: 'skoll', ...more}) as unknown as Issue
const STOCK = {id: 'stock', title: 'Stock', tasks: [
    issue('GRE-1', 'Label the jars', {blocks: ['GRE-2']}),
    issue('GRE-2', 'Fill the jars', {depends_on: ['GRE-1'], blocked_by: ['GRE-1'], blocks: ['pantry/PAN-4']}),
    issue('GRE-3', 'Shelve the jars', {column: 'done', kind: 'done'}),
]} as unknown as Chunk
const GREENHOUSE = {id: 'greenhouse', name: 'Greenhouse', key: 'GRE', releases: [], board: {chunks: [STOCK]}} as unknown as Project
const PANTRY = {id: 'pantry', name: 'Pantry', key: 'PAN', releases: [], board: {chunks: [{id: '', title: 'No chunk', tasks: [issue('PAN-4', 'Buy lids')]}]}} as unknown as Project

const settled = () => new Promise(resolve => requestAnimationFrame(resolve)).then(() => nextTick())
const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    refusing = ''
    useRoadmaps().projects.value = [PANTRY, GREENHOUSE]
    useAppSettings().settings.value.statuses = [
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
        {id: 'done', name: 'Done', kind: 'done', color: 'green'},
    ] as never
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

describe('DependsPicker', () => {
    it("offers its own project's issues first, then others' as project/ID, never itself", async () => {
        const updates: string[][] = []
        const wrapper = await mountSuspended(DependsPicker, {
            props: {here: 'greenhouse', self: 'GRE-2', modelValue: ['GRE-1'], 'onUpdate:modelValue': (v: string[]) => updates.push(v)},
            attachTo: document.body,
        })
        mounted.push(wrapper)
        await wrapper.find('button').trigger('click')
        await settled()
        const rows = () => wrapper.findAll('li').map(li => li.text())
        expect(rows()).toEqual(['GRE-1 · Label the jars', 'GRE-3 · Shelve the jars', 'pantry/PAN-4 · Buy lids'])
        await wrapper.find('input').setValue('lids')
        await settled()
        await settled()
        expect(rows()).toEqual(['pantry/PAN-4 · Buy lids'])
        await wrapper.find('input').trigger('keydown', {key: 'Enter'})
        expect(updates.at(-1)).toEqual(['GRE-1', 'pantry/PAN-4'])
    })
})

describe('IssueProperties, Depends on and Blocks', () => {
    async function mount() {
        const wrapper = await mountSuspended(IssueProperties, {props: {issue: STOCK.tasks[1]!, project: GREENHOUSE, chunk: STOCK}, attachTo: document.body})
        mounted.push(wrapper)
        return wrapper
    }

    it('links each to its page, in its own project for one in another', async () => {
        const wrapper = await mount()
        const links = wrapper.findAll('a').map(a => [a.text(), a.attributes('href')])
        expect(links).toContainEqual(['GRE-1', '/p/greenhouse/issues/GRE-1'])
        expect(links).toContainEqual(['pantry/PAN-4', '/p/pantry/issues/PAN-4'])
    })

    it('saves the whole list as the owner, and says why one is refused', async () => {
        const wrapper = await mount()
        await wrapper.find('button[aria-label="Depends on"]').trigger('click')
        await settled()
        const option = (text: string) => wrapper.findAll('li').find(li => li.text().startsWith(text))!
        await option('GRE-3').trigger('mousedown', {button: 0})
        await vi.waitFor(() => expect(sent).toEqual([{actor: 'skoll', body: {depends_on: ['GRE-1', 'GRE-3']}}]))
        refusing = 'GRE-2 would wait on itself: pantry/PAN-4 already depends on it'
        await option('pantry/PAN-4').trigger('mousedown', {button: 0})
        await vi.waitFor(() => expect(wrapper.text()).toContain('GRE-2 would wait on itself'))
    })
})
