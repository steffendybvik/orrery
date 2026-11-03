import {beforeEach, describe, expect, it} from 'vitest'
import type {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getMethod, getQuery, readBody, setResponseStatus} from 'h3'
import StatusSettings from '~/components/StatusSettings.vue'

// The orrery's statuses on App settings: renaming in place, recolouring, moving within a kind, adding, and removing with
// its issues going elsewhere. Each kind keeps at least one, and a refusal is said.
let sent: {method: string, path: string, body?: unknown, into?: unknown}[] = []
let refusal = ''
/** Refuses only this path, when set, so a request after a refused one would still go through and be seen. */
let refusing = ''
function endpoint(path: string) {
    registerEndpoint(`/api/statuses${path}`, async event => {
        if (refusal && (!refusing || refusing === path)) {
            setResponseStatus(event, 400)
            return {message: refusal}
        }
        const method = getMethod(event)
        const {into} = getQuery(event)
        sent.push({method, path, ...method === 'DELETE' ? {into} : {body: await readBody(event)}})
        return {}
    })
}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
for (const path of ['', '/backlog', '/todo', '/review', '/doing', '/done', '/canceled']) endpoint(path)

const status = (id: string, name: string, kind: string, position: number) => ({id, name, kind, position, color: 'slate'})
beforeEach(() => {
    sent = []
    refusal = ''
    refusing = ''
    useAppSettings().settings.value.statuses = [
        status('backlog', 'Backlog', 'backlog', 0), status('todo', 'Todo', 'todo', 1),
        status('doing', 'Doing', 'started', 2), status('review', 'In review', 'started', 3),
        status('done', 'Done', 'done', 4), status('canceled', 'Canceled', 'canceled', 5),
    ] as never
})

const mount = () => mountSuspended(StatusSettings)
type Wrapper = Awaited<ReturnType<typeof mount>>
const labelled = (wrapper: Wrapper, label: string) => wrapper.find(`[aria-label="${label}"]`) as unknown as DOMWrapper<HTMLButtonElement>
const pressed = (wrapper: Wrapper, text: string) => wrapper.findAll('button').find(b => b.text() === text)!.trigger('click')

describe('StatusSettings', () => {
    it('groups them by kind, saying what each kind means', async () => {
        const wrapper = await mount()
        for (const hint of ['someday', 'committed', 'being worked on', 'counts towards progress', 'out of progress']) expect(wrapper.text()).toContain(hint)
        expect((labelled(wrapper, "Doing's name").element as unknown as HTMLInputElement).value).toBe('Doing')
    })

    it('renames on leaving the field, trimmed, and only when it changed', async () => {
        const wrapper = await mount()
        const input = labelled(wrapper, "Doing's name")
        await input.setValue('Doing')
        await input.trigger('blur')
        expect(sent).toEqual([])
        await input.setValue('  Building ')
        await input.trigger('blur')
        await expect.poll(() => sent).toEqual([{method: 'PATCH', path: '/doing', body: {name: 'Building'}}])
    })

    it('puts the name back when it is emptied, or on Esc, and saves nothing', async () => {
        const wrapper = await mount()
        const input = labelled(wrapper, "Doing's name")
        await input.setValue('   ')
        await input.trigger('blur')
        expect((input.element as unknown as HTMLInputElement).value).toBe('Doing')
        await input.setValue('Something else')
        await input.trigger('keydown', {key: 'Escape'})
        expect((input.element as unknown as HTMLInputElement).value).toBe('Doing')
        expect(sent).toEqual([])
    })

    it('recolours one', async () => {
        const wrapper = await mount()
        await labelled(wrapper, 'Colour Doing teal').trigger('click')
        await expect.poll(() => sent).toEqual([{method: 'PATCH', path: '/doing', body: {color: 'teal'}}])
    })

    it('swaps one with its neighbour in the kind, and has nowhere to go past the ends', async () => {
        const wrapper = await mount()
        expect(labelled(wrapper, 'Move Doing up').element.disabled).toBe(true)
        expect(labelled(wrapper, 'Move In review down').element.disabled).toBe(true)
        await labelled(wrapper, 'Move Doing down').trigger('click')
        await expect.poll(() => sent).toEqual([
            {method: 'PATCH', path: '/doing', body: {position: 3}},
            {method: 'PATCH', path: '/review', body: {position: 2}},
        ])
    })

    it("doesn't send the second half of a swap when the first is refused", async () => {
        const wrapper = await mount()
        refusal = 'Not now'
        refusing = '/doing'
        await labelled(wrapper, 'Move Doing down').trigger('click')
        await expect.poll(() => wrapper.text()).toContain('Not now')
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(sent).toEqual([])
    })

    it('adds one to the kind asked for, in slate, and closes the form', async () => {
        const wrapper = await mount()
        const adds = wrapper.findAll('button').filter(b => b.text() === '+ Add')
        expect(adds).toHaveLength(5)
        await adds[2]!.trigger('click')
        const name = labelled(wrapper, "New status's name")
        expect((name.element as unknown as HTMLInputElement).placeholder).toContain('Blocked')
        await wrapper.find('form').trigger('submit')
        expect(sent).toEqual([])
        await name.setValue('  Blocked ')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => sent).toEqual([{method: 'POST', path: '', body: {name: 'Blocked', kind: 'started', color: 'slate'}}])
        await expect.poll(() => wrapper.find('form').exists()).toBe(false)
    })

    it('keeps the form and the name when adding is refused, and Esc closes it', async () => {
        const wrapper = await mount()
        await wrapper.findAll('button').filter(b => b.text() === '+ Add')[0]!.trigger('click')
        refusal = 'There is already a Triage'
        await labelled(wrapper, "New status's name").setValue('Triage')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.text()).toContain('There is already a Triage')
        expect(wrapper.find('form').exists()).toBe(true)
        await labelled(wrapper, "New status's name").trigger('keydown', {key: 'Escape'})
        expect(wrapper.find('form').exists()).toBe(false)
    })

    it("won't remove the only status of a kind", async () => {
        const wrapper = await mount()
        expect(labelled(wrapper, 'Remove Todo').element.disabled).toBe(true)
        expect(labelled(wrapper, 'Remove Done').element.disabled).toBe(true)
        expect(labelled(wrapper, 'Remove Doing').element.disabled).toBe(false)
    })

    it('asks first, moving its issues to another of its kind unless told otherwise, and Cancel sends nothing', async () => {
        const wrapper = await mount()
        await labelled(wrapper, 'Remove Doing').trigger('click')
        expect(wrapper.text()).toContain('Remove Doing; its issues and schedules move to')
        expect(sent).toEqual([])
        await pressed(wrapper, 'Cancel')
        expect(wrapper.text()).not.toContain('its issues and schedules move to')
        expect(sent).toEqual([])

        await labelled(wrapper, 'Remove Doing').trigger('click')
        await pressed(wrapper, 'Remove')
        await expect.poll(() => sent).toEqual([{method: 'DELETE', path: '/doing', into: 'review'}])
        await expect.poll(() => wrapper.text()).not.toContain('its issues and schedules move to')
    })

    it('keeps asking when removing is refused', async () => {
        const wrapper = await mount()
        await labelled(wrapper, 'Remove Doing').trigger('click')
        refusal = 'A schedule needs it'
        await pressed(wrapper, 'Remove')
        await expect.poll(() => wrapper.text()).toContain('A schedule needs it')
        expect(wrapper.text()).toContain('its issues and schedules move to')
    })
})
