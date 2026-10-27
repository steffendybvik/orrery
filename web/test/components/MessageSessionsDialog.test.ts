import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody} from 'h3'
import type {Project, Session} from '#shared/roadmap'
import MessageSessionsDialog from '~/components/MessageSessionsDialog.vue'

// The owner's words to every listening session at once: who it reaches as the states and projects are ticked (a
// session hearing two projects once), and what it sends.
let sent: {actor?: string, body: unknown}[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/sessions/message', {method: 'POST', handler: async event => {
    sent.push({actor: getHeader(event, 'orrery-actor'), body: await readBody(event)})
    return {sent: [{name: 'shelves'}, {name: 'kitchen'}]}
}})

const session = (id: string, project: string, state: Session['state'], more: Partial<Session> = {}) =>
    ({id, name: id, project, state, listening: true, since: '', started_at: '', ...more}) as Session
const project = (id: string, name: string) => ({id, name, key: id.toUpperCase(), board: {chunks: []}}) as unknown as Project
const kitchen = session('kitchen', 'larder', 'idle', {also: ['pantry']})

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    useRoadmaps().projects.value = [project('larder', 'Larder'), project('pantry', 'Pantry')]
    useRoadmaps().sessions.value = {
        larder: [session('shelves', 'larder', 'idle'), session('jars', 'larder', 'working'), session('deaf', 'larder', 'idle', {listening: false}), kitchen],
        pantry: [kitchen, session('tins', 'pantry', 'waiting')],
    }
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount() {
    mounted.push(await mountSuspended(MessageSessionsDialog, {props: {open: true}, attachTo: document.body}))
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    const press = (label: string) => wrapper.findAll('[aria-label="States"] button').find(b => b.text() === label)!.trigger('click')
    const tick = (id: string) => wrapper.find(`input[value="${id}"]`).setValue(true)
    return {wrapper, press, tick}
}

describe('MessageSessionsDialog', () => {
    it('reaches the idle listening sessions, a session on two projects once', async () => {
        const {wrapper} = await mount()
        expect(wrapper.text()).toContain('Reaches shelves, kitchen')
        expect(wrapper.text()).toContain('Send to 2')
    })

    it('reaches busy ones too as their states are ticked, and only the projects ticked', async () => {
        const {wrapper, press, tick} = await mount()
        await press('Working')
        await press('Waiting on you')
        expect(wrapper.text()).toContain('Send to 4')
        await tick('pantry')
        expect(wrapper.text()).toContain('Reaches kitchen, tins')
        await press('Idle')
        await press('Working')
        await press('Waiting on you')
        expect(wrapper.text()).toContain('No session like that is listening')
    })

    it('sends the words, states and projects as the owner, and says who it went to', async () => {
        const {wrapper, press, tick} = await mount()
        await press('Working')
        await tick('larder')
        await wrapper.find('textarea').setValue('  Pick the most urgent issue  ')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Sent to shelves, kitchen'))
        expect(sent).toEqual([{actor: 'skoll', body: {text: 'Pick the most urgent issue', states: ['idle', 'working'], projects: ['larder']}}])
        expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
    })

    it('sends nothing without words', async () => {
        const {wrapper} = await mount()
        await wrapper.find('textarea').setValue('   ')
        await wrapper.find('form').trigger('submit')
        expect(sent).toEqual([])
    })
})
