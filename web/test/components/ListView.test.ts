import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Issue, Milestone} from '#shared/roadmap'
import ListView from '~/components/ListView.vue'

// The list: top-level issues as rows in groups that fold, by status (open ones first, closed ones folded unless a
// filter is on) or by milestone, riskiest first with `riskFirst` (ORR-879).
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))

const issue = (id: string, column: string, more: Record<string, unknown> = {}) =>
    ({id, title: `Title ${id}`, aliases: [], labels: [], external: [], github_issues: [], tasks: [], column, status: column, kind: column === 'done' ? 'done' : 'todo', kinds: {done: 0}, ...more}) as unknown as Issue
const milestone = (id: string, title: string, tasks: Issue[], more: Record<string, unknown> = {}) =>
    ({id, title, column: 'todo', tasks, ...more}) as unknown as Milestone

const mounted: VueWrapper[] = []
beforeEach(() => {
    useAppSettings().settings.value.statuses = [
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
        {id: 'doing', name: 'Doing', kind: 'started', color: 'amber'},
        {id: 'done', name: 'Done', kind: 'done', color: 'green'},
    ] as never
    useFilters().filters.value = {...useFilters().filters.value, columns: [], priorities: [], assignees: [], labels: [], blocked: [], risks: [], query: ''}
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(props: Record<string, unknown>) {
    const wrapper = await mountSuspended(ListView, {props: {project: 'greenhouse', group: 'status', ...props}, attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}
const headers = (wrapper: VueWrapper) => wrapper.findAll('section h3 button').map(b => ({title: b.text(), open: b.attributes('aria-expanded') === 'true'}))

const board = [
    milestone('care', 'Care', [issue('GRE-1', 'done'), issue('GRE-2', 'todo'), issue('GRE-3', 'doing')]),
    milestone('', 'No milestone', [issue('GRE-4', 'todo')]),
]

describe('ListView', () => {
    it('groups by status in the statuses’ order, leaving out an empty one, and folds the closed ones', async () => {
        const wrapper = await mount({milestones: [milestone('care', 'Care', [issue('GRE-1', 'done'), issue('GRE-2', 'todo')])]})
        expect(headers(wrapper)).toEqual([{title: 'Todo', open: true}, {title: 'Done', open: false}])
        expect(wrapper.text()).toContain('GRE-2')
        expect(wrapper.text()).not.toContain('GRE-1')
    })

    it('opens and folds a group from its header, by its button or the row', async () => {
        const wrapper = await mount({milestones: board})
        await wrapper.findAll('section h3 button').find(b => b.text() === 'Done')!.trigger('click')
        expect(headers(wrapper).find(h => h.title === 'Done')!.open).toBe(true)
        expect(wrapper.text()).toContain('GRE-1')
        // Started ones come first.
        expect(headers(wrapper).map(h => h.title)).toEqual(['Doing', 'Todo', 'Done'])
        await wrapper.findAll('section > [data-nav]')[1]!.trigger('click')
        expect(headers(wrapper)[1]!.open).toBe(false)
        expect(wrapper.text()).not.toContain('GRE-2')
        expect(wrapper.text()).toContain('GRE-3')
    })

    it('opens the closed groups too while a filter is on', async () => {
        useFilters().filters.value = {...useFilters().filters.value, query: 'jar'}
        const wrapper = await mount({milestones: board})
        expect(headers(wrapper).every(h => h.open)).toBe(true)
    })

    it('says which milestone each row is in, by status, unless told not to', async () => {
        const said = await mount({milestones: board})
        expect(said.text()).toContain('Care')
        const quiet = await mount({milestones: [milestone('care', 'Kale bed', [issue('GRE-2', 'todo')])], showMilestone: false})
        expect(quiet.text()).not.toContain('Kale bed')
    })

    it('groups by milestone, its own counts shown and one with no milestone muted', async () => {
        const wrapper = await mount({group: 'milestone', milestones: [...board, milestone('empty', 'Empty', [])]})
        expect(headers(wrapper).map(h => h.title)).toEqual(['Care', 'No milestone', 'Empty'])
        const sections = wrapper.findAll('section')
        expect(sections[1]!.find('h3').classes()).toContain('italic')
        expect(sections[0]!.find('h3').classes()).not.toContain('italic')
        expect(sections[0]!.get('.font-mono').text()).toBe('3')
        expect(sections[2]!.text()).toContain('No issues yet')
    })

    it('puts the riskiest first with riskFirst, a parent as risky as its riskiest sub-issue, else keeps the order', async () => {
        const rows = [
            issue('GRE-1', 'todo'),
            issue('GRE-2', 'todo', {risk: {level: 'low'}}),
            issue('GRE-3', 'todo', {tasks: [issue('GRE-5', 'todo', {risk: {level: 'high'}})]}),
            issue('GRE-4', 'todo', {risk: {level: 'medium'}}),
        ]
        const order = (wrapper: VueWrapper) => [...wrapper.text().matchAll(/GRE-[1-4](?!\d)/g)].map(m => m[0]).filter((id, i, all) => all.indexOf(id) === i)
        expect(order(await mount({milestones: [milestone('care', 'Care', rows)]}))).toEqual(['GRE-1', 'GRE-2', 'GRE-3', 'GRE-4'])
        expect(order(await mount({milestones: [milestone('care', 'Care', rows)], riskFirst: true}))).toEqual(['GRE-3', 'GRE-4', 'GRE-2', 'GRE-1'])
    })

    it('adds what the page gives it to each header', async () => {
        const wrapper = await mountSuspended(ListView, {props: {project: 'greenhouse', group: 'status', milestones: board}, slots: {'group-end': '<em class="end">more</em>'}})
        mounted.push(wrapper)
        expect(wrapper.findAll('em.end')).toHaveLength(headers(wrapper).length)
    })
})
