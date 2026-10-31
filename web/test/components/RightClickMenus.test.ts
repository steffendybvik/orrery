import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getMethod, readBody, setResponseStatus} from 'h3'
import type {Project, Schedule, Session} from '#shared/roadmap'
import ChunkMenu from '~/components/ChunkMenu.vue'
import ScheduleMenu from '~/components/ScheduleMenu.vue'

// Right-clicking a chunk or a schedule: what each offers, what it sends, that removing asks first, and that a refusal
// stays on the menu instead of closing it.
let sent: {method: string, path: string, body?: unknown}[] = []
let refusal = ''
function endpoint(path: string, answer: Record<string, unknown> = {}) {
    registerEndpoint(`/api${path}`, async event => {
        if (refusal) {
            setResponseStatus(event, 400)
            return {message: refusal}
        }
        const method = getMethod(event)
        sent.push({method, path, ...method === 'DELETE' ? {} : {body: await readBody(event)}})
        return answer
    })
}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
endpoint('/projects/greenhouse/chunks/3')
endpoint('/projects/greenhouse/chunks/3/focus')
endpoint('/projects/greenhouse/chunks/none/focus')
endpoint('/projects/greenhouse/schedules/7', {id: 7})
endpoint('/projects/greenhouse/schedules/7/run', {outcome: 'made', issue: 'GRE-9'})

/** The button that says yes on a confirm. */
const CONFIRM = 'Remove'
const mounted: VueWrapper[] = []
const page = () => new DOMWrapper(document.body)
const press = async (label: string) => {
    const found = page().findAll('button').find(b => b.text().includes(label) || b.attributes('aria-label') === label)
    if (!found) throw new Error(`no button "${label}" in: ${page().findAll('button').map(b => b.text()).join(' | ')}`)
    await found.trigger('click')
}
const session = (id: string) => ({id, name: id, project: 'greenhouse', state: 'idle', listening: true, since: '', started_at: ''}) as Session
const issue = (id: string) => ({id, title: id, labels: [], status: 'todo', tasks: []})

beforeEach(() => {
    sent = []
    refusal = ''
    useRoadmaps().projects.value = [{id: 'greenhouse', name: 'Greenhouse', key: 'GRE', uid: 'abcd1234', board: {chunks: [
        {id: '3', title: 'Moving parts', priority: 'P1', kind: 'todo', tasks: [issue('GRE-1'), issue('GRE-2')]},
        {id: '', title: 'No chunk', kind: 'todo', tasks: [issue('GRE-3')]},
        {id: '4', title: 'Finished', kind: 'done', tasks: []},
    ]}}] as unknown as Project[]
    useRoadmaps().sessions.value = {greenhouse: [session('shelves'), session('jars')]}
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useChunkMenu().close()
    useSchedules().menu.value = null
    vi.restoreAllMocks()
})

describe('ChunkMenu', () => {
    const open = async (chunk: string) => {
        useChunkMenu().target.value = {project: 'greenhouse', chunk, x: 10, y: 10}
        mounted.push(await mountSuspended(ChunkMenu, {attachTo: document.body}) as VueWrapper)
        await expect.poll(() => page().text()).toContain('New issue in it')
    }

    it('sets its priority, and clears it, then closes', async () => {
        await open('3')
        await press('Priority P0')
        await expect.poll(() => sent).toEqual([{method: 'PATCH', path: '/projects/greenhouse/chunks/3', body: {priority: 'P0'}}])
        await expect.poll(() => useChunkMenu().target.value).toBeNull()
        useChunkMenu().target.value = {project: 'greenhouse', chunk: '3', x: 10, y: 10}
        await expect.poll(() => page().text()).toContain('New issue in it')
        await press('No priority')
        await expect.poll(() => sent.at(-1)?.body).toEqual({priority: null})
        await expect.poll(() => useChunkMenu().target.value).toBeNull()
    })

    it('asks one session or all of them, stays open and says who it reached', async () => {
        await open('3')
        expect(page().text()).toContain('Ask a session to work through it')
        await press('Ask a session to work through it')
        await expect.poll(() => page().text()).toContain('Sent to one session, the first free')
        expect(sent).toEqual([{method: 'POST', path: '/projects/greenhouse/chunks/3/focus', body: {}}])
        await press('Ask all 2 sessions to work through it')
        await expect.poll(() => page().text()).toContain('Sent to all 2 sessions')
        expect(sent.at(-1)?.body).toEqual({session: '*'})
        expect(useChunkMenu().target.value).not.toBeNull()
    })

    it('offers no asking with nobody listening, or on a chunk that is finished', async () => {
        useRoadmaps().sessions.value = {greenhouse: []}
        await open('3')
        expect(page().text()).not.toContain('work through it')
        useChunkMenu().close()
        mounted.splice(0).forEach(w => w.unmount())

        useRoadmaps().sessions.value = {greenhouse: [session('shelves')]}
        await open('4')
        expect(page().text()).not.toContain('work through it')
    })

    it('says "the session" with one listening', async () => {
        useRoadmaps().sessions.value = {greenhouse: [session('shelves')]}
        await open('3')
        expect(page().text()).toContain('Ask the session to work through it')
        expect(page().text()).not.toContain('Ask all')
        await press('Ask the session')
        await expect.poll(() => page().text()).toContain('Sent to the listening session')
    })

    it('asks before removing, saying what happens to its issues; Cancel goes back, and yes removes it', async () => {
        await open('3')
        await press('Remove…')
        await expect.poll(() => page().text()).toContain('Remove chunk 3? Its 2 issues stay, in no chunk.')
        expect(sent).toEqual([])
        await press('Cancel')
        await expect.poll(() => page().text()).toContain('New issue in it')
        expect(sent).toEqual([])
        await press('Remove…')
        await expect.poll(() => page().text()).toContain('Remove chunk 3?')
        await press(CONFIRM)
        await expect.poll(() => sent).toEqual([{method: 'DELETE', path: '/projects/greenhouse/chunks/3'}])
        await expect.poll(() => useChunkMenu().target.value).toBeNull()
    })

    it("shows the issues in no chunk neither a priority, an id to copy nor Remove", async () => {
        await open('none')
        const text = page().text()
        expect(text).toContain('No chunk')
        expect(text).not.toContain('Priority')
        expect(text).not.toContain('Copy id')
        expect(text).not.toContain('Remove')
        expect(text).toContain('Open')
    })

    it('opens New issue in that chunk, and the chunk itself', async () => {
        await open('3')
        await press('New issue in it')
        expect(useNewIssue().target.value).toMatchObject({project: 'greenhouse', chunk: '3'})
        useNewIssue().close()

        const push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
        useChunkMenu().target.value = {project: 'greenhouse', chunk: '3', x: 10, y: 10}
        await expect.poll(() => page().text()).toContain('Open')
        await press('Open')
        expect(push.mock.calls[0]?.[0]).toContain('/p/greenhouse/roadmap/3')
        expect(useChunkMenu().target.value).toBeNull()
    })

    it('stays open with what was refused', async () => {
        await open('3')
        refusal = 'Not yours to change'
        await press('Priority P0')
        await expect.poll(() => page().text()).toContain('Not yours to change')
        expect(useChunkMenu().target.value).not.toBeNull()
    })
})

describe('ScheduleMenu', () => {
    const schedule = (more: Partial<Schedule> = {}) => ({id: 7, project: 'greenhouse', title: 'Water the plants', kind: 'issue', enabled: true, updated_at: 'then', ...more}) as Schedule
    const open = async (s = schedule()) => {
        useSchedules().menu.value = {schedule: s, x: 10, y: 10}
        mounted.push(await mountSuspended(ScheduleMenu, {attachTo: document.body}) as VueWrapper)
        await expect.poll(() => page().text()).toContain('Edit')
    }

    it('pauses one that runs and resumes one that is paused', async () => {
        await open()
        await press('Pause')
        await expect.poll(() => sent).toEqual([{method: 'PATCH', path: '/projects/greenhouse/schedules/7', body: {enabled: false}}])
        await expect.poll(() => useSchedules().menu.value).toBeNull()

        await nextTick()
        useSchedules().menu.value = {schedule: schedule({enabled: false}), x: 10, y: 10}
        await expect.poll(() => page().text()).toContain('Resume')
        await press('Resume')
        await expect.poll(() => sent.at(-1)?.body).toEqual({enabled: true})
        await expect.poll(() => useSchedules().menu.value).toBeNull()
    })

    it('runs it now and closes, and offers instead of the next run only when there is one', async () => {
        await open()
        expect(page().text()).not.toContain('instead of')
        await press('Run now')
        await expect.poll(() => sent).toEqual([expect.objectContaining({method: 'POST', path: '/projects/greenhouse/schedules/7/run'})])
        await expect.poll(() => useSchedules().menu.value).toBeNull()

        mounted.splice(0).forEach(w => w.unmount())
        await open(schedule({next_run: '2030-01-01T09:30:00.000Z'}))
        expect(page().text()).toContain('Run now instead of')
        await press('Run now instead of')
        await expect.poll(() => sent.at(-1)?.body).toEqual(expect.objectContaining({instead: true}))
        await expect.poll(() => useSchedules().menu.value).toBeNull()
    })

    it("doesn't offer to run one that only moves issues, as a run by hand does nothing", async () => {
        await open(schedule({kind: 'action'}))
        expect(page().text()).not.toContain('Run now')
        expect(page().text()).toContain('Pause')
    })

    it('asks before removing, and says the issues stay', async () => {
        await open()
        await press('Remove…')
        await expect.poll(() => page().text()).toContain('Remove this schedule? The issues it made stay.')
        expect(sent).toEqual([])
        await press(CONFIRM)
        await expect.poll(() => sent).toEqual([{method: 'DELETE', path: '/projects/greenhouse/schedules/7'}])
        await expect.poll(() => useSchedules().menu.value).toBeNull()
    })

    it('leaves a project out of one across projects, rather than removing it', async () => {
        await open(schedule({across: 2}))
        expect(page().text()).not.toContain('Remove…')
        await press('Leave this project out…')
        await expect.poll(() => page().text()).toContain('Leave this project out of it? The issues it made stay.')
    })

    it('opens the dialog to edit it, and closes', async () => {
        const s = schedule()
        await open(s)
        await press('Edit')
        expect(useSchedules().editing.value).toMatchObject({project: 'greenhouse', schedule: {id: 7}})
        expect(useSchedules().menu.value).toBeNull()
        useSchedules().editing.value = null
    })

    it('stays open with what was refused', async () => {
        await open()
        refusal = 'Only yours to change'
        await press('Pause')
        await expect.poll(() => page().text()).toContain('Only yours to change')
        expect(useSchedules().menu.value).not.toBeNull()
    })
})
