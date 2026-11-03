import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {setResponseStatus} from 'h3'
import type {Session} from '#shared/roadmap'
import IssueWorkerBanner from '~/components/IssueWorkerBanner.vue'

// The banner on an issue's page saying which session is on it (ORR-536): its dot pulsing only while it works, its
// state (rose while it needs a permission), how long it's been on the issue, and Watch only for one orrery started,
// saying so when Watch couldn't open it.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/greenhouse/launches/l1/watch', {method: 'POST', handler: event => {
    setResponseStatus(event, 409)
    return {message: 'No launcher is running'}
}})

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const session = (over: Partial<Session> = {}) => ({
    id: 'shelves', name: 'orrery · Shelves', project: 'greenhouse', state: 'working', listening: true,
    since: minutesAgo(0), started_at: minutesAgo(30), ...over,
}) as Session
const mounted: VueWrapper[] = []
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(props: {session: Session, since?: string}) {
    const wrapper = await mountSuspended(IssueWorkerBanner, {props})
    mounted.push(wrapper)
    return wrapper
}

describe('IssueWorkerBanner', () => {
    it('pulses while the session works, and says how long it has been on the issue', async () => {
        const wrapper = await mount({session: session(), since: minutesAgo(20)})
        expect(wrapper.text()).toContain('orrery · Shelves is working on this')
        expect(wrapper.find('.animate-ping').exists()).toBe(true)
        // The time on the issue, not the few seconds since its last turn began.
        expect(wrapper.text()).toContain('working · took it 20m ago')
    })

    it("doesn't pulse while idle, and falls back to its state's time without one on the issue", async () => {
        const wrapper = await mount({session: session({state: 'idle', since: minutesAgo(5)})})
        expect(wrapper.find('.animate-ping').exists()).toBe(false)
        expect(wrapper.text()).toContain('idle · since 5m ago')
    })

    it('shows a session waiting on a permission in rose', async () => {
        const wrapper = await mount({session: session({state: 'waiting'})})
        const state = wrapper.findAll('span').find(s => s.text().startsWith('permission needed'))!
        expect(state.classes()).toContain('text-rose-700')
    })

    it('offers Watch only for a session orrery started, and says why it could not open', async () => {
        expect((await mount({session: session()})).find('button').exists()).toBe(false)
        const wrapper = await mount({session: session({started: {launch: 'l1', tmux: 'orrery-l1'}})})
        const watch = wrapper.find('button')
        expect(watch.text()).toBe('Watch')
        await watch.trigger('click')
        await expect.poll(() => wrapper.text()).toContain('No launcher is running')
    })
})
