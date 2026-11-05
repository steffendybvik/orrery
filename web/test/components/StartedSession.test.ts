import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {getRouterParam, readBody, setResponseStatus} from 'h3'
import type {Session} from '#shared/roadmap'
import StartedSession from '~/components/StartedSession.vue'

// A session orrery started, on its card (ORR-866): Watch, Show screen and Stop out front, Stop on the first press, and
// under ⋯ the tmux command to copy and +30 minutes for one with a time. On a phone, Watch and Stop fold into ⋯ (ORR-828).
let sent: {what: string, body: unknown}[] = []
let failing = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
for (const what of ['stop', 'extend', 'watch']) {
    registerEndpoint(`/api/projects/shop/launches/9/${what}`, {method: 'POST', handler: async (event: H3Event) => {
        if (failing) {
            setResponseStatus(event, 409)
            return {message: 'Its launcher is offline'}
        }
        sent.push({what: getRouterParam(event, 'what') ?? what, body: await readBody(event)})
        return {}
    }})
}

const session = (over: Partial<Session['started']> = {}) => ({
    id: 's1', project: 'shop', name: 'shop · Brokk', started_at: '2026-11-04T10:00:00Z',
    started: {launch: 9, tmux: 'orrery-shop-9', stops_at: '2026-11-04T11:00:00Z', ...over},
}) as unknown as Session

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    failing = false
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    vi.restoreAllMocks()
})
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}

/** Mounted wide, or as on a phone, which the component reads from a media query once mounted. */
async function mount(started?: Partial<Session['started']>, {phone = false} = {}) {
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
        matches: phone, media: query, addEventListener: () => {}, removeEventListener: () => {},
    }) as unknown as MediaQueryList)
    const wrapper = await mountSuspended(StartedSession, {props: {session: session(started)}, attachTo: document.body})
    mounted.push(wrapper as VueWrapper)
    await settle()
    const button = (text: string) => wrapper.findAll('button').find(b => b.text().startsWith(text))
    const more = async () => {
        await wrapper.find('button[aria-label="More for shop · Brokk"]').trigger('click')
        await settle()
    }
    return {wrapper, button, more}
}

describe('StartedSession', () => {
    it('opens a terminal on it with Watch', async () => {
        const {button} = await mount()
        await button('Watch')!.trigger('click')
        await settle()
        expect(sent).toEqual([{what: 'watch', body: {}}])
    })

    it('stops it on the first press, with no asking again (ORR-971)', async () => {
        const {wrapper, button} = await mount()
        await button('Stop')!.trigger('click')
        await settle()
        expect(sent).toEqual([{what: 'stop', body: {}}])
        expect(wrapper.text()).not.toContain('Stop shop · Brokk?')
        expect(button('Cancel')).toBeUndefined()
    })

    it('shows and hides its screen', async () => {
        const {wrapper, button} = await mount()
        await button('Show screen')!.trigger('click')
        expect(wrapper.emitted('update:viewing')).toEqual([[true]])
    })

    it('gives it 30 minutes more, and copies the tmux command, from ⋯', async () => {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true})
        const {wrapper, button, more} = await mount()
        await more()
        await button('+30 minutes')!.trigger('click')
        await settle()
        expect(sent).toEqual([{what: 'extend', body: {minutes: 30}}])
        await more()
        await button('Copy')!.trigger('click')
        await settle()
        expect(writeText).toHaveBeenCalledWith('tmux attach -t orrery-shop-9')
        expect(wrapper.text()).toContain('Copied')
    })

    it('has no +30 minutes for one without a time', async () => {
        const {button, more} = await mount({stops_at: null})
        await more()
        expect(button('+30 minutes')).toBeUndefined()
        expect(button('Copy')).toBeDefined()
    })

    it('folds Watch and Stop into ⋯ on a phone', async () => {
        const {wrapper, button, more} = await mount({}, {phone: true})
        expect(button('Watch')).toBeUndefined()
        expect(wrapper.findAll('button').filter(b => b.text() === 'Stop')).toHaveLength(0)
        await more()
        await button('Watch')!.trigger('click')
        await settle()
        expect(sent).toEqual([{what: 'watch', body: {}}])
        await more()
        await button('Stop')!.trigger('click')
        await settle()
        expect(sent).toEqual([{what: 'watch', body: {}}, {what: 'stop', body: {}}])
    })

    it('says why its launcher refused', async () => {
        failing = true
        const {wrapper, button} = await mount()
        await button('Watch')!.trigger('click')
        await settle()
        expect(wrapper.text()).toContain('Its launcher is offline')
    })
})
