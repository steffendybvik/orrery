import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {getHeader, getMethod, readBody, setResponseStatus} from 'h3'
import type {Project, Schedule} from '#shared/roadmap'
import ScheduleDialog from '~/components/ScheduleDialog.vue'

// Writing a schedule as the owner: what a new one sends (an issue's fields, or a message that needs words), editing
// one already made, and removing it after asking once more.
let sent: {method: string, path: string, actor?: string, body?: unknown}[] = []
let failing = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const record = (path: string) => async (event: H3Event) => {
    if (failing) {
        setResponseStatus(event, 400)
        return {message: 'That cron never runs'}
    }
    const method = getMethod(event)
    sent.push({method, path, actor: getHeader(event, 'orrery-actor'), ...method === 'DELETE' ? {} : {body: await readBody(event)}})
    return {}
}
registerEndpoint('/api/projects/greenhouse/schedules', {method: 'POST', handler: record('schedules')})
for (const method of ['PATCH', 'DELETE'] as const) registerEndpoint('/api/projects/greenhouse/schedules/3', {method, handler: record('schedules/3')})

const project = (id: string, name: string) => ({id, name, key: id.toUpperCase(), board: {chunks: [{id: 'pantry', title: 'Pantry', tasks: []}]}}) as unknown as Project
const SWEEP = {id: 3, kind: 'message', title: 'Nudge', notes: 'Idle? Pick one.', cron: '*/15 * * * *', timezone: 'Europe/Oslo', column: 'todo', labels: [],
    ask: false, skip_open: true, only_if_changed: true, enabled: true} as unknown as Schedule

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    failing = false
    useRoadmaps().projects.value = [project('greenhouse', 'Greenhouse')]
    useAppSettings().settings.value.statuses = [{id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'}] as never
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useSchedules().editing.value = null
})

async function mount(schedule?: Schedule) {
    useSchedules().edit('greenhouse', schedule)
    mounted.push(await mountSuspended(ScheduleDialog, {attachTo: document.body}))
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    const button = (text: string) => wrapper.findAll('button, [role=radio]').find(b => b.text().startsWith(text))!
    const submit = () => wrapper.find('form').trigger('submit')
    return {wrapper, button, submit}
}

describe('ScheduleDialog', () => {
    it('makes an issue every weekday at nine by default, as the owner', async () => {
        const {wrapper, submit} = await mount()
        await wrapper.find('input[aria-label="Title"]').setValue('  Code maintenance ')
        await wrapper.find('input[aria-label="Timezone"]').setValue('Europe/Oslo')
        await submit()
        await vi.waitFor(() => expect(useSchedules().editing.value).toBeNull())
        expect(sent).toEqual([{method: 'POST', path: 'schedules', actor: 'skoll', body: {
            kind: 'issue', title: 'Code maintenance', notes: null, cron: '0 9 * * 1-5', timezone: 'Europe/Oslo', column: 'todo',
            chunk: null, priority: null, labels: [], ask: false, skip_open: true, only_if_changed: false, untrusted: false,
        }}])
    })

    it("won't send a message schedule without its words", async () => {
        const {wrapper, button, submit} = await mount()
        await button('Sends a message').trigger('click')
        await wrapper.find('input[aria-label="Title"]').setValue('Nudge')
        expect(button('Create schedule').attributes('disabled')).toBeDefined()
        await submit()
        expect(sent).toEqual([])
        await wrapper.find('textarea[aria-label="Message"]').setValue('Idle? Pick one.')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]?.body).toMatchObject({kind: 'message', title: 'Nudge', notes: 'Idle? Pick one.'})
    })

    it('opens one already made as it is, and saves the change to it', async () => {
        const {wrapper, submit} = await mount(SWEEP)
        expect((wrapper.find('input[aria-label="Title"]').element as HTMLInputElement).value).toBe('Nudge')
        expect((wrapper.find('textarea[aria-label="Message"]').element as HTMLTextAreaElement).value).toBe('Idle? Pick one.')
        await wrapper.find('input[aria-label="Title"]').setValue('Nudge, gently')
        await submit()
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toMatchObject({method: 'PATCH', path: 'schedules/3', body: {kind: 'message', title: 'Nudge, gently', cron: '*/15 * * * *', only_if_changed: true}})
    })

    it('removes one only once asked again', async () => {
        const {wrapper, button} = await mount(SWEEP)
        await button('Remove').trigger('click')
        expect(wrapper.text()).toContain('Remove this schedule? The issues it made stay.')
        await button('Cancel').trigger('click')
        expect(sent).toEqual([])
        await button('Remove').trigger('click')
        await wrapper.findAll('button').filter(b => b.text() === 'Remove').at(-1)!.trigger('click')
        await vi.waitFor(() => expect(sent).toEqual([{method: 'DELETE', path: 'schedules/3', actor: 'skoll'}]))
        await vi.waitFor(() => expect(useSchedules().editing.value).toBeNull())
    })

    it('stays open with why when saving fails', async () => {
        failing = true
        const {wrapper, submit} = await mount(SWEEP)
        await submit()
        await vi.waitFor(() => expect(wrapper.text()).toContain('That cron never runs'))
        expect(useSchedules().editing.value).not.toBeNull()
    })
})
