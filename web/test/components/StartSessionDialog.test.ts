import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody, setResponseStatus} from 'h3'
import type {Project} from '#shared/roadmap'
import StartSessionDialog from '~/components/StartSessionDialog.vue'

// Starting sessions as the owner: why a project can't, what each project's launch is sent (the scope, the orrery's
// presets ticked and only its own, its project alone to hear), one session for projects served from one repo, none
// ticked for one session hearing every project, a refused one staying ticked to try again, and several of each at once,
// as many as the limit has room for.
let sent: {project: string, actor?: string, body: unknown}[] = []
let refusing: string[] = []
/** Sessions each project starts before refusing the rest, when it's set. */
let room: Record<string, number> = {}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/presets', () => [{id: 1, project: null, name: 'Reviewer', text: 'Review it first'}])
const STATES: Record<string, object> = {
    greenhouse: {launchers: 1, folders: ['/src/kitchen'], every: false, started: 0, starting: 0, total: 0},
    pantry: {launchers: 1, folders: ['/src/pantry'], every: false, started: 0, starting: 0, total: 0},
    cellar: {launchers: 0, folders: [], every: false, started: 0, starting: 0, total: 0},
    loft: {launchers: 1, folders: ['/src/loft'], every: false, started: 1, starting: 0, total: 1},
    scullery: {launchers: 1, folders: ['/src/kitchen'], every: false, started: 0, starting: 0, total: 0},
}
for (const [n, id] of Object.keys(STATES).entries()) {
    registerEndpoint(`/api/projects/${id}/presets`, () => [{id: 1, project: null, name: 'Reviewer', text: ''}, {id: 11 + n, project: id, name: `${id} hand`, text: ''}])
    registerEndpoint(`/api/projects/${id}/launches`, {method: 'GET', handler: () => STATES[id]})
    registerEndpoint(`/api/projects/${id}/launches`, {method: 'POST', handler: async event => {
        if (refusing.includes(id) || sent.filter(s => s.project === id).length >= (room[id] ?? Infinity)) {
            setResponseStatus(event, 409)
            return {message: 'orrery already has its 2 sessions at once'}
        }
        sent.push({project: id, actor: getHeader(event, 'orrery-actor'), body: await readBody(event)})
        return {}
    }})
}

const issue = (id: string, column: string, kind: string) => ({id, title: id, column, kind, tasks: [], labels: []})
const project = (id: string, starts: object | null) => ({
    id, name: id[0]!.toUpperCase() + id.slice(1), key: id.toUpperCase(), starts, releases: [],
    board: {chunks: [{id: '', title: 'No chunk', tasks: [issue(`${id}-1`, 'todo', 'todo'), issue(`${id}-2`, 'in-progress', 'started'), issue(`${id}-3`, 'backlog', 'backlog')]}]},
}) as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    refusing = []
    room = {}
    useRoadmaps().projects.value = [
        project('greenhouse', {limit: 4, minutes: 30}), project('pantry', {limit: 2}), project('cellar', {limit: 2}), project('loft', {limit: 1}), project('attic', null), project('scullery', {limit: 2}),
    ]
    useAppSettings().settings.value.statuses = [
        {id: 'backlog', name: 'Backlog', kind: 'backlog', color: 'slate'},
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
        {id: 'in-progress', name: 'In progress', kind: 'started', color: 'amber'},
    ] as never
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useStartSession().close()
})

async function mount(on: string | null) {
    useStartSession().open(on)
    mounted.push(await mountSuspended(StartSessionDialog, {attachTo: document.body}))
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    const row = (id: string) => wrapper.find(`input[value="${id}"]`).element.closest('label')!.textContent ?? ''
    const submit = () => wrapper.findAll('button').find(b => b.text().startsWith('Start session'))!
    // Each project's launch state comes in over the (stubbed) API: slow under coverage, so it's given time.
    await vi.waitFor(() => expect(row('cellar')).toContain('No launcher running'), {timeout: 5000})
    return {wrapper, row, submit}
}

/** Waits for `n` starts and the dialog closing after them: it closes once its own requests come back, which can be
 * after the stub has them, and a close landing in the next test would shut that test's dialog before it shows. */
async function started(n: number) {
    await vi.waitFor(() => expect(sent).toHaveLength(n))
    await vi.waitFor(() => expect(useStartSession().target.value).toBeNull())
}

describe('StartSessionDialog', () => {
    it("says why a project can't start a session now", async () => {
        const {row, wrapper} = await mount(null)
        expect(row('attic')).toContain("orrery doesn't start sessions")
        expect(row('loft')).toContain('At the limit of 1')
        expect(row('greenhouse')).toContain('30 min')
        expect(row('pantry')).toContain('until stopped')
        expect(wrapper.find('input[value="cellar"]').attributes('disabled')).toBeDefined()
    })

    it('starts one on the project it opened on, through its Todo and In progress issues, as the owner', async () => {
        const {row, submit, wrapper} = await mount('greenhouse')
        expect(row('greenhouse')).toContain('2 issues')
        await vi.waitFor(() => expect(submit().attributes('disabled')).toBeUndefined())
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(useStartSession().target.value).toBeNull())
        expect(sent).toEqual([{project: 'greenhouse', actor: 'skoll', body: {statuses: ['todo', 'in-progress'], presets: [], hears: ['greenhouse']}}])
    })

    it("gives each project's session the orrery's presets ticked and only its own", async () => {
        const {wrapper} = await mount('greenhouse')
        await wrapper.find('input[value="pantry"]').setValue(true)
        await vi.waitFor(() => expect(wrapper.findAll('[aria-label="Presets"] button')).toHaveLength(3))
        for (const button of wrapper.findAll('[aria-label="Presets"] button')) await button.trigger('click')
        await wrapper.find('textarea').setValue('  Run the e2e suite  ')
        // Greenhouse and Pantry are in repos of their own, so there's no starting one session for both.
        expect(wrapper.text()).not.toContain('One session for all')
        await wrapper.find('form').trigger('submit')
        await started(2)
        expect(sent.map(s => [s.project, s.body])).toEqual([
            ['greenhouse', {statuses: ['todo', 'in-progress'], presets: [1, 11], instructions: 'Run the e2e suite', hears: ['greenhouse']}],
            ['pantry', {statuses: ['todo', 'in-progress'], presets: [1, 12], instructions: 'Run the e2e suite', hears: ['pantry']}],
        ])
    })

    it('starts one session hearing projects served from one repo, or a session each', async () => {
        const {wrapper} = await mount('greenhouse')
        await wrapper.find('input[value="scullery"]').setValue(true)
        await vi.waitFor(() => expect(wrapper.text()).toContain('One session for all 2'))
        expect(wrapper.text()).toContain('one session hearing them all')
        await wrapper.find('form').trigger('submit')
        await started(1)
        expect(sent[0]).toMatchObject({project: 'greenhouse', body: {hears: ['greenhouse', 'scullery']}})

        sent = []
        const again = (await mount('greenhouse')).wrapper
        await again.find('input[value="scullery"]').setValue(true)
        await vi.waitFor(() => expect(again.text()).toContain('One session for all 2'))
        await again.findAll('[role=radio]').find(b => b.text() === 'A session each')!.trigger('click')
        await again.find('form').trigger('submit')
        await started(2)
        expect(sent.map(s => [s.project, (s.body as {hears: string[]}).hears])).toEqual([['greenhouse', ['greenhouse']], ['scullery', ['scullery']]])
    })

    it('asks for a launcher serving every project before starting one with none ticked', async () => {
        const {wrapper, submit} = await mount(null)
        expect(wrapper.text()).toContain('ORRERY_PROJECTS=*')
        expect(submit().attributes('disabled')).toBeDefined()
    })

    it('starts one session hearing every project with none ticked, where a launcher serves them all', async () => {
        // Scullery's launcher runs where the channel serves every project; Greenhouse, before it, doesn't. Set before
        // the dialog opens: remounting one mid-test races Headless UI's portal, and under coverage the second can lose.
        Object.assign(STATES.scullery!, {every: true})
        try {
            const {wrapper, submit} = await mount(null)
            await vi.waitFor(() => expect(wrapper.text()).toContain("One session hearing every project, projects made later too, started in Scullery's repo."))
            expect(wrapper.text()).toContain('none ticked: one session hearing every project')
            await vi.waitFor(() => expect(wrapper.findAll('[aria-label="Presets"] button').length).toBeGreaterThan(0))
            await wrapper.findAll('[aria-label="Presets"] button').find(b => b.text().includes('Reviewer'))!.trigger('click')
            await wrapper.find('textarea').setValue('Triage what came in overnight')
            expect(submit().attributes('disabled')).toBeUndefined()
            await wrapper.find('form').trigger('submit')
            await started(1)
            // No `hears`, so it hears what the channel serves, and no scope: nothing was ticked to work through.
            expect(sent[0]).toEqual({project: 'scullery', actor: 'skoll', body: {presets: [1], instructions: 'Triage what came in overnight'}})
        } finally {
            Object.assign(STATES.scullery!, {every: false})
        }
    })

    it('keeps a refused project ticked, with why, and lets the rest go', async () => {
        refusing = ['pantry']
        const {wrapper} = await mount('greenhouse')
        await wrapper.find('input[value="pantry"]').setValue(true)
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Pantry: orrery already has its 2 sessions at once'))
        expect(sent.map(s => s.project)).toEqual(['greenhouse'])
        expect((wrapper.find('input[value="greenhouse"]').element as HTMLInputElement).checked).toBe(false)
        expect((wrapper.find('input[value="pantry"]').element as HTMLInputElement).checked).toBe(true)
        expect(useStartSession().target.value).not.toBeNull()
    })

    it('starts several of the same, as many as the limit has room for', async () => {
        const {wrapper} = await mount('greenhouse')
        const count = () => wrapper.find('input[aria-label="Sessions to start"]')
        await vi.waitFor(() => expect(count().attributes('max')).toBe('4'))
        await count().setValue(9)
        await count().trigger('change')
        expect((count().element as HTMLInputElement).value).toBe('4')
        await count().setValue(3)
        expect(wrapper.find('button[type=submit]').text()).toContain('Start 3 sessions')
        await wrapper.find('form').trigger('submit')
        await started(3)
        expect(sent.map(s => s.body)).toEqual(Array(3).fill({statuses: ['todo', 'in-progress'], presets: [], hears: ['greenhouse']}))
    })

    it('splits the room among the projects picked, and starts one on a single issue', async () => {
        const {wrapper} = await mount('greenhouse')
        const count = () => wrapper.find('input[aria-label="Sessions to start"]')
        await vi.waitFor(() => expect(count().exists()).toBe(true))
        // Pantry's limit is 2, so a session each leaves room for one of each.
        await wrapper.find('input[value="pantry"]').setValue(true)
        await vi.waitFor(() => expect(count().exists()).toBe(false))
        await wrapper.find('input[value="pantry"]').setValue(false)
        await vi.waitFor(() => expect(count().exists()).toBe(true))
        // A session on one issue is never joined by another.
        await wrapper.find('button[aria-label="Issue"]').trigger('click')
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]').length).toBeGreaterThan(1))
        // Headless UI picks on the press.
        await wrapper.findAll('[role="option"]').find(o => o.text().includes('greenhouse-1 ·'))!.trigger('mousedown', {button: 0})
        await vi.waitFor(() => expect(count().exists()).toBe(false))
    })

    it('says how many started when the limit refuses the rest', async () => {
        room = {greenhouse: 1}
        const {wrapper} = await mount('greenhouse')
        const count = () => wrapper.find('input[aria-label="Sessions to start"]')
        await vi.waitFor(() => expect(count().exists()).toBe(true))
        await count().setValue(3)
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Greenhouse: 1 of 3 started, then orrery already has its 2 sessions at once'))
        expect(sent).toHaveLength(1)
    })
})
