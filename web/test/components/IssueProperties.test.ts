import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {nextTick} from 'vue'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody} from 'h3'
import type {Milestone, Issue, Project} from '#shared/roadmap'
import {WORK_KINDS} from '#shared/roadmap'
import IssueProperties from '~/components/IssueProperties.vue'

// An issue's own model on its page (ORR-869, ORR-889): empty by default, which follows its kind's and says so, a pick
// saved as the owner, the empty choice sending null to follow the kind again, and a full id set through the API kept
// as a choice.
let sent: {actor?: string, body: unknown}[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/greenhouse/issues/GRE-1', {method: 'PATCH', handler: async event => {
    sent.push({actor: getHeader(event, 'orrery-actor'), body: await readBody(event)})
    return {}
}})

const issue = (more: Record<string, unknown> = {}) => ({id: 'GRE-1', title: 'Write the watering guide', aliases: [], labels: ['docs'], external: [], github_issues: [], tasks: [], column: 'todo', kind: 'todo', kinds: {done: 0}, created_by: 'skoll', ...more}) as unknown as Issue
const milestone = (task: Issue) => ({id: 'care', title: 'Care', tasks: [task]}) as unknown as Milestone
const project = (task: Issue) => ({id: 'greenhouse', name: 'Greenhouse', key: 'GRE', releases: [], board: {milestones: [milestone(task)]}}) as unknown as Project

const settled = () => new Promise(resolve => requestAnimationFrame(resolve)).then(() => nextTick())
const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    useAppSettings().settings.value.statuses = [{id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'}] as never
    useAppSettings().settings.value.work_kinds = [...WORK_KINDS]
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(task: Issue) {
    const wrapper = await mountSuspended(IssueProperties, {props: {issue: task, project: project(task), milestone: milestone(task)}, attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}
async function open(wrapper: VueWrapper) {
    await wrapper.find('button[data-picker="Model"]').trigger('click')
    await settled()
    return wrapper.findAll('li').map(li => li.text())
}
async function pick(wrapper: VueWrapper, text: string) {
    await wrapper.findAll('li').find(li => li.text() === text)!.trigger('mousedown', {button: 0})
    await settled()
}

describe("IssueProperties, an issue's own model", () => {
    it("shows its kind's model while it has none, and offers the aliases a session takes", async () => {
        const wrapper = await mount(issue())
        expect(wrapper.get('[data-testid="issue-model"]').text()).toBe('sonnet, as Docs')
        const options = await open(wrapper)
        expect(options[0]).toBe('sonnet, as Docs')
        expect(options).toEqual(expect.arrayContaining(['best', 'opus', 'sonnet', 'haiku', 'fable']))
        expect(options).not.toContain('default')
        expect(options).not.toContain('opusplan')
    })

    it("follows the kind as the owner sets it in Sessions setup", async () => {
        useAppSettings().settings.value.work_kinds = WORK_KINDS.map(k => k.id === 'docs' ? {...k, model: 'haiku'} : k)
        const wrapper = await mount(issue())
        expect(wrapper.get('[data-testid="issue-model"]').text()).toBe('haiku, as Docs')
    })

    it('saves a pick as the owner', async () => {
        const wrapper = await mount(issue())
        await open(wrapper)
        await pick(wrapper, 'opus')
        await vi.waitFor(() => expect(sent).toEqual([{actor: 'skoll', body: {model: 'opus'}}]))
    })

    it("sends null for the empty choice, so it follows its kind again", async () => {
        const wrapper = await mount(issue({model: 'opus'}))
        expect(wrapper.get('[data-testid="issue-model"]').text()).toBe('opus')
        await open(wrapper)
        await pick(wrapper, 'sonnet, as Docs')
        await vi.waitFor(() => expect(sent).toEqual([{actor: 'skoll', body: {model: null}}]))
    })

    it('keeps a full id set through the API as a choice', async () => {
        const wrapper = await mount(issue({model: 'claude-opus-5-5'}))
        expect(wrapper.get('[data-testid="issue-model"]').text()).toBe('claude-opus-5-5')
        expect(await open(wrapper)).toContain('claude-opus-5-5')
    })
})
