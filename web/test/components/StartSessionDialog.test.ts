import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody, setResponseStatus} from 'h3'
import type {Project} from '#shared/roadmap'
import StartSessionDialog from '~/components/StartSessionDialog.vue'

// Starting sessions as the owner: why a project can't, what each project's launch is sent (the scope, the Orrery's
// presets ticked and only its own, its project alone to hear), one session for projects served from one repo, and a
// refused one staying ticked to try again.
let sent: {project: string, actor?: string, body: unknown}[] = []
let refusing: string[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/presets', () => [{id: 1, project: null, name: 'Reviewer', text: 'Review it first'}])
const STATES: Record<string, object> = {
    larder: {launchers: 1, folders: ['/src/kitchen'], started: 0, starting: 0, total: 0},
    pantry: {launchers: 1, folders: ['/src/pantry'], started: 0, starting: 0, total: 0},
    cellar: {launchers: 0, folders: [], started: 0, starting: 0, total: 0},
    loft: {launchers: 1, folders: ['/src/loft'], started: 1, starting: 0, total: 1},
    scullery: {launchers: 1, folders: ['/src/kitchen'], started: 0, starting: 0, total: 0},
}
for (const [n, id] of Object.keys(STATES).entries()) {
    registerEndpoint(`/api/projects/${id}/presets`, () => [{id: 1, project: null, name: 'Reviewer', text: ''}, {id: 11 + n, project: id, name: `${id} hand`, text: ''}])
    registerEndpoint(`/api/projects/${id}/launches`, {method: 'GET', handler: () => STATES[id]})
    registerEndpoint(`/api/projects/${id}/launches`, {method: 'POST', handler: async event => {
        if (refusing.includes(id)) {
            setResponseStatus(event, 409)
            return {message: 'Orrery already has its 2 sessions at once'}
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
    useRoadmaps().projects.value = [
        project('larder', {limit: 2, minutes: 30}), project('pantry', {limit: 2}), project('cellar', {limit: 2}), project('loft', {limit: 1}), project('attic', null), project('scullery', {limit: 2}),
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
    const wrapper = await mountSuspended(StartSessionDialog, {global: {stubs: {teleport: true}}})
    mounted.push(wrapper)
    const row = (id: string) => wrapper.find(`input[value="${id}"]`).element.closest('label')!.textContent ?? ''
    const submit = () => wrapper.findAll('button').find(b => b.text().startsWith('Start session'))!
    // Each project's launch state comes in over the (stubbed) API: slow under coverage, so it's given time.
    await vi.waitFor(() => expect(row('cellar')).toContain('No launcher running'), {timeout: 5000})
    return {wrapper, row, submit}
}

describe('StartSessionDialog', () => {
    it("says why a project can't start a session now", async () => {
        const {row, wrapper} = await mount(null)
        expect(row('attic')).toContain("Orrery doesn't start sessions")
        expect(row('loft')).toContain('At the limit of 1')
        expect(row('larder')).toContain('30 min')
        expect(row('pantry')).toContain('until stopped')
        expect(wrapper.find('input[value="cellar"]').attributes('disabled')).toBeDefined()
    })

    it('starts one on the project it opened on, through its Todo and In progress issues, as the owner', async () => {
        const {row, submit, wrapper} = await mount('larder')
        expect(row('larder')).toContain('2 issues')
        await vi.waitFor(() => expect(submit().attributes('disabled')).toBeUndefined())
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(useStartSession().target.value).toBeNull())
        expect(sent).toEqual([{project: 'larder', actor: 'skoll', body: {statuses: ['todo', 'in-progress'], presets: [], hears: ['larder']}}])
    })

    it("gives each project's session the Orrery's presets ticked and only its own", async () => {
        const {wrapper} = await mount('larder')
        await wrapper.find('input[value="pantry"]').setValue(true)
        await vi.waitFor(() => expect(wrapper.findAll('[aria-label="Presets"] button')).toHaveLength(3))
        for (const button of wrapper.findAll('[aria-label="Presets"] button')) await button.trigger('click')
        await wrapper.find('textarea').setValue('  Run the e2e suite  ')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent.map(s => [s.project, s.body])).toEqual([
            ['larder', {statuses: ['todo', 'in-progress'], presets: [1, 11], instructions: 'Run the e2e suite', hears: ['larder']}],
            ['pantry', {statuses: ['todo', 'in-progress'], presets: [1, 12], instructions: 'Run the e2e suite', hears: ['pantry']}],
        ])
        // Larder and Pantry are in repos of their own, so there's no starting one session for both.
        expect(wrapper.text()).not.toContain('One session for all')
    })

    it('starts one session hearing projects served from one repo, or a session each', async () => {
        const {wrapper} = await mount('larder')
        await wrapper.find('input[value="scullery"]').setValue(true)
        await vi.waitFor(() => expect(wrapper.text()).toContain('One session for all 2'))
        expect(wrapper.text()).toContain('one session hearing them all')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toMatchObject({project: 'larder', body: {hears: ['larder', 'scullery']}})

        sent = []
        const again = (await mount('larder')).wrapper
        await again.find('input[value="scullery"]').setValue(true)
        await vi.waitFor(() => expect(again.text()).toContain('One session for all 2'))
        await again.findAll('button').find(b => b.text() === 'A session each')?.trigger('click')
        await again.find('form').trigger('submit')
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent.map(s => [s.project, (s.body as {hears: string[]}).hears])).toEqual([['larder', ['larder']], ['scullery', ['scullery']]])
    })

    it('keeps a refused project ticked, with why, and lets the rest go', async () => {
        refusing = ['pantry']
        const {wrapper} = await mount('larder')
        await wrapper.find('input[value="pantry"]').setValue(true)
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Pantry: Orrery already has its 2 sessions at once'))
        expect(sent.map(s => s.project)).toEqual(['larder'])
        expect((wrapper.find('input[value="larder"]').element as HTMLInputElement).checked).toBe(false)
        expect((wrapper.find('input[value="pantry"]').element as HTMLInputElement).checked).toBe(true)
        expect(useStartSession().target.value).not.toBeNull()
    })
})
