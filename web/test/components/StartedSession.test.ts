import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {readBody, setResponseStatus} from 'h3'
import type {Session} from '#shared/roadmap'
import StartedSession from '~/components/StartedSession.vue'

// A session orrery started, on its card (ORR-866): Watch, Show screen and Stop out front, Stop asking once more, and
// under ⋯ +30 minutes and the tmux command to copy. On a phone Watch and Stop fold into ⋯ (ORR-828). A refused action
// says why on the card.
let calls: {what: string, body: unknown}[] = []
let refuse = false
const act = (what: string) => async (event: H3Event) => {
    if (refuse) {
        setResponseStatus(event, 409)
        return {message: 'Its launcher has gone'}
    }
    calls.push({what, body: await readBody(event)})
    return {}
}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
for (const what of ['stop', 'extend', 'watch']) registerEndpoint(`/api/projects/greenhouse/launches/L7/${what}`, {method: 'POST', handler: act(what)})

const session = (over: Partial<Session['started']> = {}) => ({
    id: 'shelves', name: 'shelves', project: 'greenhouse', state: 'working', listening: true, since: '', started_at: '',
    started: {launch: 'L7', tmux: 'orrery-greenhouse-shelves', ...over},
}) as Session

const mounted: VueWrapper[] = []
beforeEach(() => {
    calls = []
    refuse = false
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    vi.unstubAllGlobals()
})

/** `phone` makes the screen narrower than Tailwind's sm, as a phone's is. */
async function mount(given: Session, phone = false) {
    if (phone) vi.stubGlobal('matchMedia', (query: string) => ({matches: true, media: query, addEventListener() {}, removeEventListener() {}}))
    const wrapper = await mountSuspended(StartedSession, {props: {session: given}, attachTo: document.body})
    mounted.push(wrapper)
    const button = (text: string) => wrapper.findAll('button').find(b => b.text() === text)
    const more = async () => {
        await wrapper.find('button[aria-label="More for shelves"]').trigger('click')
        await vi.waitFor(() => expect(wrapper.findAll('[role="menuitem"]').length).toBeGreaterThan(0))
        return wrapper.findAll('[role="menuitem"]')
    }
    return {wrapper, button, more}
}

describe('StartedSession', () => {
    it('shows nothing for a session orrery didn\'t start', async () => {
        const wrapper = await mountSuspended(StartedSession, {props: {session: {...session(), started: undefined}}})
        mounted.push(wrapper)
        expect(wrapper.find('button').exists()).toBe(false)
    })

    it('opens a terminal on it with Watch', async () => {
        const {button} = await mount(session())
        await button('Watch')!.trigger('click')
        await vi.waitFor(() => expect(calls).toEqual([{what: 'watch', body: {}}]))
    })

    it('shows and hides its screen', async () => {
        const {wrapper, button} = await mount(session())
        expect(button('Show screen')!.attributes('aria-expanded')).toBe('false')
        await button('Show screen')!.trigger('click')
        expect(wrapper.emitted('update:viewing')).toEqual([[true]])
        await wrapper.setProps({viewing: true})
        expect(button('Hide screen')!.attributes('aria-expanded')).toBe('true')
    })

    it('asks once more before Stop, and Cancel leaves it running', async () => {
        const {wrapper, button} = await mount(session())
        await button('Stop')!.trigger('click')
        expect(wrapper.text()).toContain('Stop shelves?')
        await button('Cancel')!.trigger('click')
        expect(wrapper.text()).not.toContain('Stop shelves?')
        expect(calls).toEqual([])
        await button('Stop')!.trigger('click')
        await button('Stop')!.trigger('click')
        await vi.waitFor(() => expect(calls).toEqual([{what: 'stop', body: {}}]))
        await vi.waitFor(() => expect(wrapper.text()).not.toContain('Stop shelves?'))
    })

    it('gives one with a time 30 more minutes, and copies the command that attaches to it', async () => {
        const writeText = vi.fn(async () => {})
        vi.stubGlobal('navigator', {...navigator, clipboard: {writeText}})
        const {wrapper, more} = await mount(session({stops_at: '2026-11-04T18:00:00Z'}))
        const items = await more()
        expect(items.map(i => i.text())).toEqual(['+30 minutes', 'Copy tmux attach -t orrery-greenhouse-shelves'])
        await items[0]!.trigger('click')
        await vi.waitFor(() => expect(calls).toEqual([{what: 'extend', body: {minutes: 30}}]))
        const again = await more()
        await again[1]!.trigger('click')
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('tmux attach -t orrery-greenhouse-shelves'))
        await vi.waitFor(() => expect(wrapper.text()).toContain('Copied'))
    })

    it('offers no more time to one that runs until stopped', async () => {
        const {more} = await mount(session())
        expect((await more()).map(i => i.text())).toEqual(['Copy tmux attach -t orrery-greenhouse-shelves'])
    })

    it('folds Watch and Stop into ⋯ on a phone, keeping Show screen out', async () => {
        const {wrapper, button, more} = await mount(session(), true)
        expect(button('Watch')).toBeUndefined()
        expect(button('Stop')).toBeUndefined()
        expect(button('Show screen')).toBeDefined()
        const items = await more()
        expect(items.map(i => i.text())).toEqual(["Watch · opens on its launcher's machine", 'Copy tmux attach -t orrery-greenhouse-shelves', 'Stop…'])
        await items[2]!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Stop shelves?'))
    })

    it('says why an action was refused', async () => {
        refuse = true
        const {wrapper, button} = await mount(session())
        await button('Watch')!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Its launcher has gone'))
        expect(button('Watch')!.attributes('disabled')).toBeUndefined()
    })
})
