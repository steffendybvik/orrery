import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {getMethod, readBody, setResponseStatus} from 'h3'
import type {Project, Schedule, ScheduleAcross} from '#shared/roadmap'
import ScheduleDialog from '~/components/ScheduleDialog.vue'

// The rest of what the dialog writes: a run on an event (a common one with its filters, or a pattern), a move of issues
// with no session, a session or a message from presets, a schedule across projects, an agent's made the owner's, pausing
// and resuming, the other repeats, and what it says when the server can't be reached.
let sent: {method: string, path: string, body?: unknown}[] = []
// A path that answers with a refusal, or with nothing (the server gone).
let refusing = ''
let gone = ''
const ADOPTED = {id: 3, project: 'greenhouse', kind: 'issue', title: 'Groom', cron: '0 9 * * 1-5', timezone: 'Europe/Oslo', column: 'todo',
    labels: [], ask: false, skip_open: true, enabled: true, protected: true}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const record = (path: string, answer: () => unknown = () => ({})) => async (event: H3Event) => {
    const method = getMethod(event)
    if (refusing === `${method} ${path}`) {
        setResponseStatus(event, 409)
        return {statusCode: 409, message: 'An agent changed it since you read it'}
    }
    if (gone === `${method} ${path}`) {
        setResponseStatus(event, 502)
        return {}
    }
    sent.push({method, path, ...method === 'DELETE' ? {} : {body: await readBody(event)}})
    return answer()
}
registerEndpoint('/api/projects/greenhouse/schedules', {method: 'POST', handler: record('schedules', () => ({...ADOPTED, id: 9}))})
for (const method of ['PATCH', 'DELETE'] as const) registerEndpoint('/api/projects/greenhouse/schedules/3', {method, handler: record('schedules/3', () => ADOPTED)})
registerEndpoint('/api/projects/greenhouse/schedules/3/adopt', {method: 'POST', handler: record('adopt', () => ADOPTED)})
registerEndpoint('/api/schedules', {method: 'POST', handler: record('across')})
for (const method of ['PATCH', 'DELETE'] as const) registerEndpoint('/api/schedules/across/7', {method, handler: record('across/7')})
registerEndpoint('/api/schedules/across', () => [])
const PRESETS = [{id: 1, name: 'Reviewer', text: 'Review its pull request.'}, {id: 2, name: 'Tester', text: 'Run the tests.'}]
registerEndpoint('/api/projects/greenhouse/presets', () => PRESETS)
registerEndpoint('/api/presets', () => PRESETS)

const project = (id: string, name: string) => ({id, name, key: id.toUpperCase(), board: {milestones: [{id: 'pantry', title: 'Pantry', tasks: []}]}}) as unknown as Project
const MINE = {id: 3, project: 'greenhouse', kind: 'issue', title: 'Groom', notes: '', cron: '0 9 * * 1-5', timezone: 'Europe/Oslo', column: 'todo',
    labels: [], ask: false, skip_open: true, enabled: true, protected: true} as unknown as Schedule
const GROUP = {id: 7, kind: 'issue', title: 'Weekly tidy', cron: '0 9 * * 1', timezone: 'Europe/Oslo', column: 'todo', labels: [], projects: '*',
    skip: ['shed'], on_projects: ['greenhouse'], enabled: true, created_by: 'skoll', created_at: '', updated_at: ''} as unknown as ScheduleAcross

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    refusing = ''
    gone = ''
    useRoadmaps().projects.value = [project('greenhouse', 'Greenhouse'), project('shed', 'Shed')]
    useAppSettings().settings.value.statuses = [
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'}, {id: 'review', name: 'In review', kind: 'started', color: 'amber'},
        {id: 'done', name: 'Done', kind: 'done', color: 'green'},
    ] as never
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useSchedules().editing.value = null
})

async function mount(opening: () => void) {
    opening()
    mounted.push(await mountSuspended(ScheduleDialog, {attachTo: document.body}))
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    const button = (text: string) => wrapper.findAll('button, [role=radio]').find(b => b.text().startsWith(text))!
    const submit = () => wrapper.find('form').trigger('submit')
    const title = (text: string) => wrapper.find('input[aria-label="Title"]').setValue(text)
    // A picker opened, as a person presses it, so Headless UI's outside-press check sees where it started; what it offers.
    async function open(label: string) {
        const opener = wrapper.find(`button[data-picker="${label}"]`)
        for (const type of ['pointerdown', 'mousedown', 'click']) await opener.trigger(type, {button: 0})
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]').length).toBeGreaterThan(0))
        return wrapper.findAll('[role="option"]').map(o => o.text().trim())
    }
    // One of an open picker's options picked: Headless UI picks on the press.
    async function pick(option: string) {
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]').map(o => o.text().trim())).toContain(option))
        const it = wrapper.findAll('[role="option"]').find(o => o.text().trim() === option)!
        await it.trigger('mousedown', {button: 0})
        await it.trigger('click', {button: 0})
        await vi.waitFor(() => expect(wrapper.findAll('[role="option"]')).toHaveLength(0))
        // The option it was pressed on has gone: a press inside the dialog, so the next click isn't taken for one outside it.
        await wrapper.find('form').trigger('mousedown', {button: 0})
        await wrapper.find('form').trigger('click', {button: 0})
    }
    const choose = async (label: string, option: string) => {
        await open(label)
        await pick(option)
    }
    // Until it has closed: a save still on its way would close the next test's dialog.
    const closed = () => vi.waitFor(() => expect(useSchedules().editing.value).toBeNull())
    return {wrapper, button, submit, title, open, pick, choose, closed}
}
const fresh = () => mount(() => useSchedules().edit('greenhouse'))

describe('ScheduleDialog, on an event', () => {
    it('runs on an issue moving to a status, by someone, and sends no time', async () => {
        const {wrapper, button, submit, title, choose, closed} = await fresh()
        await title('Review what moves')
        await button('Event').trigger('click')
        expect(wrapper.text()).toContain('Runs once for each thing it\'s about')
        await choose('Moves to', 'In review')
        await choose('By', 'A session')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toEqual({kind: 'issue', title: 'Review what moves', notes: null, on: 'issue.status', on_filter: {to: 'review', by: 'session'},
            column: 'todo', milestone: null, priority: null, labels: [], ask: false, model: null, effort: null})
        await closed()
    })

    it('lets go of the filters another event showed, and of who for one orrery notes itself', async () => {
        const {wrapper, button, submit, title, choose, closed} = await fresh()
        await title('Watch labels')
        await button('Event').trigger('click')
        await choose('Event', "An issue's labels change")
        await wrapper.find('input[aria-label="Changed to"]').setValue('  bug ')
        await choose('By', 'You')
        // An error has a level, and nobody did it.
        await choose('Event', 'A new error (server or page)')
        expect(wrapper.find('input[aria-label="Changed to"]').exists()).toBe(false)
        expect(wrapper.find('button[data-picker="By"]').exists()).toBe(false)
        await choose('Level', 'error')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toMatchObject({on: '*.error', on_filter: {level: 'error'}})
        await closed()
    })

    it('takes a pattern typed in, and refuses one that isn\'t', async () => {
        const {wrapper, button, submit, title, choose, closed} = await fresh()
        await title('Anything released')
        await button('Event').trigger('click')
        await choose('Event', 'Another event or pattern…')
        await wrapper.find('input[aria-label="Event type or pattern"]').setValue('Release!')
        expect(wrapper.text()).toContain('Type an event, e.g.')
        expect(button('Create schedule').attributes('disabled')).toBeDefined()
        await wrapper.find('input[aria-label="Event type or pattern"]').setValue(' release.* ')
        await wrapper.find('input[aria-label="Changed to"]').setValue('frozen')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toMatchObject({on: 'release.*', on_filter: {to: 'frozen'}})
        await closed()
    })

    it('opens one on an event as it was, a pattern included', async () => {
        const {wrapper} = await mount(() => useSchedules().edit('greenhouse', {...MINE, cron: undefined, on: 'pr.*', on_filter: {to: 'x', level: 'warn'}} as never))
        expect((wrapper.find('input[aria-label="Event type or pattern"]').element as HTMLInputElement).value).toBe('pr.*')
        expect((wrapper.find('input[aria-label="Changed to"]').element as HTMLInputElement).value).toBe('x')
        expect(wrapper.find('button[data-picker="Level"]').text()).toContain('warn')
    })
})

describe('ScheduleDialog, moving issues', () => {
    it('runs on an event, moves to done by default from the statuses ticked, and has no model', async () => {
        const {wrapper, button, submit, title, closed} = await fresh()
        await title('Merged PR closes its issue')
        await button('Moves issues').trigger('click')
        expect(wrapper.text()).toContain('On an event')
        expect(wrapper.find('[data-testid="schedule-model"]').exists()).toBe(false)
        expect(wrapper.text()).toContain('From any open status')
        const from = (label: string) => wrapper.find('[aria-label="Moves it from"]').findAll('button').find(b => b.text().includes(label))!
        await from('Todo').trigger('click')
        await from('In review').trigger('click')
        await from('Todo').trigger('click')
        expect(wrapper.text()).toContain('Only from the statuses ticked.')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toEqual({kind: 'action', title: 'Merged PR closes its issue', notes: null, move_from: ['review'], on: 'issue.status', on_filter: {}, column: 'done'})
        await closed()
    })

    it('goes back to its time, and an open status, on another tab', async () => {
        const {wrapper, button, title} = await fresh()
        await title('Tidy')
        await button('Moves issues').trigger('click')
        await button('Makes an issue').trigger('click')
        expect(wrapper.find('input[aria-label="Time"]').exists()).toBe(true)
        expect(wrapper.find('button[data-picker="Status it starts in"]').text()).toContain('Todo')
    })
})

describe('ScheduleDialog, from presets', () => {
    it('starts a session from the presets ticked, in the order ticked, with no words of its own', async () => {
        const {wrapper, button, submit, title, closed} = await fresh()
        await title('Review')
        await button('Starts a session').trigger('click')
        expect(wrapper.text()).toContain("Give it your words or a preset")
        const preset = (name: string) => wrapper.find('[aria-label="Presets"]').findAll('button').find(b => b.text().includes(name))!
        await vi.waitFor(() => expect(preset('Tester')).toBeDefined())
        await preset('Tester').trigger('click')
        await preset('Reviewer').trigger('click')
        await preset('Tester').trigger('click')
        await preset('Tester').trigger('click')
        expect(preset('Reviewer').attributes('aria-pressed')).toBe('true')
        await button('Event').trigger('click')
        expect(wrapper.text()).toContain("It starts on what the event was about")
        expect(wrapper.find('button[data-picker="Model"]').text()).toContain("The issue's, or Claude Code's default")
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toMatchObject({kind: 'session', presets: [1, 2], on: 'issue.status'})
        await closed()
    })

    it('sends an untrusted message as a session of its own, and an untrusted one made an issue lets go of it', async () => {
        const {wrapper, button, submit, closed} = await mount(() => useSchedules().edit('greenhouse', {...MINE, kind: 'message', notes: 'Read the GitHub issues', untrusted: true}))
        expect(wrapper.text()).toContain('Each run starts a session for this message alone.')
        expect(wrapper.find('button[data-picker="Model"]').text()).toContain("Claude Code's default")
        await button('Makes an issue').trigger('click')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toMatchObject({kind: 'issue', untrusted: false})
        await closed()
    })
})

describe('ScheduleDialog, across projects', () => {
    it('makes one for all projects but those unticked, and reads them again', async () => {
        const {wrapper, submit, title, open, pick, choose, closed} = await fresh()
        await choose('Project', 'All projects')
        expect(wrapper.text()).toContain('a project added later joins in')
        // It can't name a milestone, nor run once.
        expect(wrapper.find('button[data-picker="Milestone"]').exists()).toBe(false)
        expect(await open('Repeats')).not.toContain('Once')
        await pick('Weekdays')
        const reach = (name: string) => wrapper.find('[aria-label="Projects it\'s for"]').findAll('button').find(b => b.text() === name)!
        await reach('Shed').trigger('click')
        expect(reach('Shed').attributes('aria-pressed')).toBe('false')
        await title('Tidy everywhere')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toMatchObject({method: 'POST', path: 'across', body: {title: 'Tidy everywhere', projects: '*', skip: ['shed']}})
        expect(sent[0]!.body).not.toHaveProperty('milestone')
        await closed()
    })

    it('needs a project ticked when it\'s for several, and a once becomes weekdays', async () => {
        const {wrapper, button, submit, title, choose, closed} = await fresh()
        await choose('Repeats', 'Once')
        await choose('Project', 'Several projects…')
        expect(wrapper.find('button[data-picker="Repeats"]').text()).toContain('Weekdays')
        await title('Tidy two')
        expect(button('Create schedule').attributes('disabled')).toBeDefined()
        await wrapper.find('[aria-label="Projects it\'s for"]').findAll('button').find(b => b.text() === 'Greenhouse')!.trigger('click')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toMatchObject({projects: ['greenhouse'], skip: []})
        await closed()
    })

    it('changes, pauses and removes one for every project', async () => {
        const {wrapper, button, submit, closed} = await mount(() => useSchedules().editAcross(GROUP))
        expect(wrapper.text()).toContain('Edit schedule in')
        await button('❙❙ Pause').trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain("Paused: it won't run until you resume it"))
        expect(sent[0]).toEqual({method: 'PATCH', path: 'across/7', body: {enabled: false}})
        await button('Remove').trigger('click')
        expect(wrapper.text()).toContain('Remove it from every project? The issues it made stay.')
        await button('Cancel').trigger('click')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent[1]).toMatchObject({method: 'PATCH', path: 'across/7', body: {title: 'Weekly tidy', projects: '*', skip: ['shed'], cron: '0 9 * * 1'}})
        await closed()
        mounted.splice(0).forEach(w => w.unmount())

        const again = await mount(() => useSchedules().editAcross(GROUP))
        await again.button('Remove').trigger('click')
        await again.wrapper.findAll('button').filter(b => b.text() === 'Remove').at(-1)!.trigger('click')
        await vi.waitFor(() => expect(sent.at(-1)).toEqual({method: 'DELETE', path: 'across/7'}))
        await again.closed()
    })
})

describe("ScheduleDialog, an agent's", () => {
    it.each([
        [{kind: 'issue'}, 'It makes its issues, but an agent can change it'],
        [{kind: 'session'}, 'It starts no session until you make it yours: then'],
        [{kind: 'message', untrusted: true}, 'It starts no session until you make it yours.'],
        [{kind: 'message'}, "Its message doesn't reach the sessions"],
        [{kind: 'action', on: 'pr.merged'}, 'It moves nothing until you make it yours'],
    ])('says what %o does until it\'s the owner\'s', async (change, says) => {
        const {wrapper} = await mount(() => useSchedules().edit('greenhouse', {...MINE, notes: 'Hi', protected: false, ...change} as Schedule))
        expect(wrapper.find('[role="note"]').text()).toContain(says)
    })

    it('makes it the owner\'s, and says why it can\'t when an agent changed it since', async () => {
        const {wrapper, button} = await mount(() => useSchedules().edit('greenhouse', {...MINE, protected: false, updated_at: '2026-11-20T09:00:00Z'} as Schedule))
        refusing = 'POST adopt'
        await button('Make it mine').trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('An agent changed it since you read it'))
        refusing = ''
        await button('Make it mine').trigger('click')
        await vi.waitFor(() => expect(wrapper.find('[role="note"]').exists()).toBe(false))
        expect(sent).toEqual([{method: 'POST', path: 'adopt', body: {seen: '2026-11-20T09:00:00Z'}}])
    })
})

describe('ScheduleDialog, pausing and failing', () => {
    it('pauses and resumes one at once', async () => {
        const {wrapper, button} = await mount(() => useSchedules().edit('greenhouse', MINE))
        await button('❙❙ Pause').trigger('click')
        await vi.waitFor(() => expect(button('▶ Resume')).toBeDefined())
        await button('▶ Resume').trigger('click')
        await vi.waitFor(() => expect(button('❙❙ Pause')).toBeDefined())
        expect(sent.map(s => s.body)).toEqual([{enabled: false}, {enabled: true}])
        expect(wrapper.text()).not.toContain('Paused:')
    })

    it('makes a paused suggestion paused', async () => {
        const {submit, closed} = await mount(() => useSchedules().edit('greenhouse', undefined, {title: 'Suggested', enabled: false}))
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toMatchObject({title: 'Suggested', enabled: false})
        await closed()
    })

    it.each([
        ['PATCH schedules/3', '❙❙ Pause', "Couldn't pause it. Is orrery running?"],
        ['DELETE schedules/3', 'Remove', "Couldn't remove it. Is orrery running?"],
    ])('says what failed when %s gets no answer', async (path, press, says) => {
        const {wrapper, button} = await mount(() => useSchedules().edit('greenhouse', MINE))
        gone = path
        await button(press).trigger('click')
        if (press === 'Remove') await wrapper.findAll('button').filter(b => b.text() === 'Remove').at(-1)!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain(says))
        expect(useSchedules().editing.value).not.toBeNull()
    })
})

describe('ScheduleDialog, its repeats', () => {
    it.each([
        ['Some days of the week', '0 9 * * 1,3'],
        ['Monthly', '0 9 15 * *'],
        ['Every N minutes', '*/15 * * * *'],
        ['Every N hours', '20 */4 * * *'],
        ['Advanced (cron)', '30 6 * * 0'],
    ])('sends %s as its cron', async (repeats, cron) => {
        const {wrapper, button, submit, title, choose, closed} = await fresh()
        await title('Tick')
        await choose('Repeats', repeats)
        if (repeats === 'Some days of the week') await wrapper.find('[aria-label="Days"]').findAll('button').find(b => b.text() === 'Wed')!.trigger('click')
        if (repeats === 'Monthly') await wrapper.find('input[aria-label="Day of the month"]').setValue('15')
        if (repeats === 'Every N hours') await wrapper.find('input[aria-label="Minute"]').setValue('20')
        if (repeats === 'Advanced (cron)') await wrapper.find('input[aria-label="Cron"]').setValue('30 6 * * 0')
        expect(wrapper.text()).toContain("Next runs"); expect(button("Create schedule")?.attributes("disabled")).toBeUndefined()
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toMatchObject({cron})
        await closed()
    })

    it('runs once at a time to come, and not at one gone', async () => {
        const {wrapper, button, submit, title, choose, closed} = await fresh()
        await title('Once')
        await choose('Repeats', 'Once')
        await wrapper.find('input[aria-label="When"]').setValue('2001-01-01T09:00')
        expect(wrapper.text()).toContain('Pick a time that hasn’t passed')
        expect(button('Create schedule').attributes('disabled')).toBeDefined()
        await wrapper.find('input[aria-label="When"]').setValue('2099-01-01T09:00')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.body).toMatchObject({at: new Date('2099-01-01T09:00').toISOString()})
        expect(sent[0]!.body).not.toHaveProperty('cron')
        await closed()
    })

    it('opens each repeat it was made with', async () => {
        const opened = async (cron: string) => {
            const {wrapper} = await mount(() => useSchedules().edit('greenhouse', {...MINE, cron}))
            const repeats = wrapper.find('button[data-picker="Repeats"]').text()
            mounted.splice(0).forEach(w => w.unmount())
            return repeats
        }
        expect(await opened('0 9 * * 2,4')).toContain('Some days of the week')
        expect(await opened('0 9 3 * *')).toContain('Monthly')
        expect(await opened('*/10 * * * *')).toContain('Every N minutes')
        expect(await opened('5 */2 * * *')).toContain('Every N hours')
        expect(await opened('1 2 3 4 5')).toContain('Advanced (cron)')
    })
})
