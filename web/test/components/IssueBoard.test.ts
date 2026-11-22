import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {Issue, Milestone} from '#shared/roadmap'
import IssueBoard from '~/components/IssueBoard.vue'

// The board: issues as cards in their columns, started first and closed folded; a card moved by dragging it or by
// [ and ], with the ticked ones; out of Proposed never while proposals are restricted, and into it only by the
// owner (ORR-781); and why a move failed.
let sent: {id: string, body: unknown}[] = []
let refuse: string[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
for (const id of ['GRE-1', 'GRE-2', 'GRE-3', 'GRE-4', 'GRE-5']) {
    registerEndpoint(`/api/projects/greenhouse/issues/${id}`, {method: 'PATCH', handler: async event => {
        sent.push({id, body: await readBody(event)})
        if (refuse.includes(id)) {
            setResponseStatus(event, 409)
            return {statusCode: 409, message: 'It moved since'}
        }
        return {}
    }})
}

const issue = (id: string, column: string, more: Record<string, unknown> = {}) =>
    ({id, title: `Title ${id}`, aliases: [], labels: [], external: [], github_issues: [], tasks: [], column, status: column, kind: column === 'done' ? 'done' : column === 'doing' ? 'started' : 'todo', kinds: {done: 0}, ...more}) as unknown as Issue
const care = (tasks: Issue[]) => [{id: 'care', title: 'Care', column: 'todo', tasks}] as unknown as Milestone[]

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    refuse = []
    useAppSettings().settings.value.statuses = [
        {id: 'proposed', name: 'Proposed', kind: 'proposed', color: 'violet'},
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
        {id: 'doing', name: 'Doing', kind: 'started', color: 'amber'},
        {id: 'done', name: 'Done', kind: 'done', color: 'green'},
    ] as never
    useAppSettings().settings.value.restrict_proposals = false
    useFilters().filters.value = {...useFilters().filters.value, columns: [], priorities: [], assignees: [], labels: [], blocked: [], risks: [], query: ''}
    useSelection().selected.value = []
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(tasks: Issue[]) {
    const wrapper = await mountSuspended(IssueBoard, {props: {project: 'greenhouse', milestones: care(tasks)}, attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}
const titles = (wrapper: VueWrapper) => wrapper.findAll('section h2').map(h => h.text())
const column = (wrapper: VueWrapper, id: string) => wrapper.get(`section[data-column="${id}"]`)
const card = (wrapper: VueWrapper, id: string) => wrapper.get(`article[data-issue="${id}"]`)
async function drag(wrapper: VueWrapper, from: string, to: string) {
    await card(wrapper, from).trigger('dragstart')
    await column(wrapper, to).trigger('dragover')
    await column(wrapper, to).trigger('drop')
}

describe('IssueBoard', () => {
    it("lays out the statuses' columns, started first and closed last, and folds a closed one to a count", async () => {
        const wrapper = await mount([issue('GRE-1', 'todo'), issue('GRE-2', 'doing'), issue('GRE-3', 'done'), issue('GRE-4', 'done')])
        expect(titles(wrapper)).toEqual(['Doing', 'Todo', 'Proposed', 'Done'])
        expect(column(wrapper, 'proposed').text()).toContain('Nothing here')
        expect(column(wrapper, 'done').find('article').exists()).toBe(false)
        expect(column(wrapper, 'done').text()).toContain('2 issues done')
        await column(wrapper, 'done').findAll('button').find(b => b.text() === 'Show')!.trigger('click')
        expect(column(wrapper, 'done').findAll('article')).toHaveLength(2)
        await column(wrapper, 'done').findAll('button').find(b => b.text() === 'Fold')!.trigger('click')
        expect(column(wrapper, 'done').find('article').exists()).toBe(false)
        // The count unfolds it too, and says one issue as one.
        await mount([issue('GRE-5', 'done')]).then(async one => {
            expect(column(one, 'done').text()).toContain('1 issue done')
            await column(one, 'done').get('button[data-nav]').trigger('click')
            expect(column(one, 'done').findAll('article')).toHaveLength(1)
        })
    })

    it("shows a card's milestone, labels, sub-issue progress and comments", async () => {
        const wrapper = await mount([issue('GRE-1', 'todo', {labels: ['a', 'b', 'c', 'd'], comments: 4, tasks: [issue('GRE-2', 'done')], kinds: {backlog: 0, todo: 1, started: 0, done: 1, proposed: 0}})])
        const text = card(wrapper, 'GRE-1').text()
        expect(text).toContain('Care')
        expect(text).toContain('1/2')
        expect(text).toContain('4')
        // Three labels at most.
        expect(card(wrapper, 'GRE-1').findAllComponents({name: 'LabelChip'}).map(c => c.props('label'))).toEqual(['a', 'b', 'c'])
    })

    it('moves a card dragged to another column, as the owner, and not to the one it is in', async () => {
        const wrapper = await mount([issue('GRE-1', 'todo'), issue('GRE-2', 'doing')])
        await drag(wrapper, 'GRE-1', 'todo')
        await drag(wrapper, 'GRE-1', 'doing')
        await vi.waitFor(() => expect(sent).toEqual([{id: 'GRE-1', body: {status: 'doing'}}]))
    })

    it('offers the columns the filter hides as places to drop while a card is dragged', async () => {
        useFilters().filters.value = {...useFilters().filters.value, columns: ['todo', 'doing']}
        const wrapper = await mount([issue('GRE-1', 'todo')])
        expect(titles(wrapper)).toEqual(['Doing', 'Todo'])
        await card(wrapper, 'GRE-1').trigger('dragstart')
        expect(titles(wrapper)).toEqual(['Doing', 'Todo', 'Proposed', 'Done'])
        expect(column(wrapper, 'done').text()).toContain('Drop to move to Done')
        await column(wrapper, 'done').trigger('dragover')
        expect(column(wrapper, 'done').classes()).toContain('ring-2')
        await column(wrapper, 'done').trigger('drop')
        await vi.waitFor(() => expect(sent).toEqual([{id: 'GRE-1', body: {status: 'done'}}]))
        expect(titles(wrapper)).toEqual(['Doing', 'Todo'])
    })

    it('moves the ticked cards with a ticked one, and the focused one by [ and ]', async () => {
        const wrapper = await mount([issue('GRE-1', 'todo'), issue('GRE-2', 'todo'), issue('GRE-3', 'doing')])
        useSelection().selected.value = ['greenhouse/GRE-1', 'greenhouse/GRE-2'] as never
        await wrapper.vm.$nextTick()
        await drag(wrapper, 'GRE-1', 'done')
        await vi.waitFor(() => expect(sent.map(s => s.id).sort()).toEqual(['GRE-1', 'GRE-2']))

        sent = []
        useSelection().selected.value = []
        await card(wrapper, 'GRE-3').trigger('keydown', {key: ']'})
        await vi.waitFor(() => expect(sent).toEqual([{id: 'GRE-3', body: {status: 'todo'}}]))
        sent = []
        await card(wrapper, 'GRE-3').trigger('keydown', {key: ']', metaKey: true})
        await card(wrapper, 'GRE-3').trigger('keydown', {key: 'x'})
        // Started first: Doing has no column left of it.
        await card(wrapper, 'GRE-3').trigger('keydown', {key: '['})
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(sent).toEqual([])
    })

    it('while proposals are restricted, keeps a proposal where it is and lets only the owner drag one in', async () => {
        useAppSettings().settings.value.restrict_proposals = true
        const wrapper = await mount([issue('GRE-1', 'proposed', {proposal: 'pending'}), issue('GRE-2', 'todo')])
        expect(column(wrapper, 'proposed').find('[aria-label="Only you move proposals"]').exists()).toBe(true)
        expect(card(wrapper, 'GRE-1').attributes('draggable')).toBe('false')
        await drag(wrapper, 'GRE-1', 'todo')
        await card(wrapper, 'GRE-1').trigger('keydown', {key: ']'})
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(sent).toEqual([])
        // The owner (no one logged in) drags one in, which puts it up as a proposal.
        await drag(wrapper, 'GRE-2', 'proposed')
        await vi.waitFor(() => expect(sent).toEqual([{id: 'GRE-2', body: {proposal: 'pending'}}]))
    })

    it('approves nothing by moving a proposal out while proposals are open, it only commits it', async () => {
        const wrapper = await mount([issue('GRE-1', 'proposed', {proposal: 'pending'})])
        await drag(wrapper, 'GRE-1', 'todo')
        await vi.waitFor(() => expect(sent).toEqual([{id: 'GRE-1', body: {status: 'todo', proposal: null}}]))
    })

    it('says which moves failed and why, and goes away on a click', async () => {
        refuse = ['GRE-2']
        const wrapper = await mount([issue('GRE-1', 'todo'), issue('GRE-2', 'todo')])
        useSelection().selected.value = ['greenhouse/GRE-1', 'greenhouse/GRE-2'] as never
        await wrapper.vm.$nextTick()
        await drag(wrapper, 'GRE-1', 'doing')
        await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toBe("Couldn't move GRE-2: It moved since"))
        await wrapper.get('[role="alert"]').trigger('click')
        expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    })

    it('clears the drag when it ends without a drop', async () => {
        const wrapper = await mount([issue('GRE-1', 'todo')])
        await card(wrapper, 'GRE-1').trigger('dragstart')
        expect(card(wrapper, 'GRE-1').classes()).toContain('opacity-40')
        await card(wrapper, 'GRE-1').trigger('dragend')
        expect(card(wrapper, 'GRE-1').classes()).not.toContain('opacity-40')
    })
})
