import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Project, Session, SessionWork} from '#shared/roadmap'
import SessionCard from '~/components/SessionCard.vue'

// A session on the Sessions page (ORR-866): its quiet line (its state, what it asks for, its time left, its folder, the
// other projects it hears, a cut-off), the chips of a session listed across projects, and what it's on now: its issues in
// progress with the rest folded under them, and the latest thing it was sent.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/shop/presets', () => [])

const project = (id: string, name: string) => ({id, name, key: id.toUpperCase()}) as unknown as Project
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const session = (over: Partial<Session> = {}): Session => ({
    id: 's1', project: 'shop', name: 'shop · Brokk', state: 'idle', since: new Date().toISOString(), started_at: new Date().toISOString(),
    listening: false, ...over,
})

const mounted: VueWrapper[] = []
beforeEach(() => {
    useRoadmaps().projects.value = [project('shop', 'Shop'), project('blog', 'Blog')]
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})
async function mount(props: {session: Session, work?: SessionWork, spans?: boolean}) {
    const wrapper = await mountSuspended(SessionCard, {props: {project: 'shop', ...props}})
    mounted.push(wrapper as VueWrapper)
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
    return wrapper
}

describe("a session's line", () => {
    it('says what it asks permission for while it waits, and the folder it runs in', async () => {
        const wrapper = await mount({session: session({state: 'waiting', cwd: '/Users/ada/shop', asking: {name: 'Bash', detail: 'pnpm test'}})})
        expect(wrapper.text()).toContain('permission needed')
        expect(wrapper.text()).toContain('for Bash')
        expect(wrapper.text()).toContain('pnpm test')
        expect(wrapper.text()).toContain('in shop/')
    })

    it("counts a started session's time left, in hours and minutes, and says once it's past", async () => {
        const started = (stops_at?: string) => ({launch: '9', tmux: 'orrery-shop-9', stops_at})
        expect((await mount({session: session({started: started(minutesFromNow(90))})})).text()).toContain('1h 30m left')
        expect((await mount({session: session({started: started(minutesFromNow(25))})})).text()).toContain('25m left')
        expect((await mount({session: session({started: started(minutesFromNow(-5))})})).text()).toContain('stops when done')
        expect((await mount({session: session({started: started()})})).text()).not.toContain('left')
    })

    it('says a usage limit cut its last turn off', async () => {
        const wrapper = await mount({session: session({cut_off: {error: 'rate_limit', text: 'Try again at 5pm', at: new Date().toISOString()}})})
        expect(wrapper.find('[data-testid="session-cut-off"]').text()).toBe('· usage limit reached: Try again at 5pm')
    })

    it('names the other projects a listening session hears, or shows each as a chip when listed across them', async () => {
        const listening = session({listening: true, also: ['blog']})
        useRoadmaps().projects.value = [project('shop', 'Shop'), project('blog', 'Blog'), project('docs', 'Docs')]
        expect((await mount({session: listening})).text()).toContain('also on Blog')
        const across = await mount({session: listening, spans: true})
        expect(across.find('[aria-label="Hears Shop, Blog"]').exists()).toBe(true)
        expect(across.text()).not.toContain('also on')
        // Every project the orrery has, once there are only those two.
        useRoadmaps().projects.value = [project('shop', 'Shop'), project('blog', 'Blog')]
        expect((await mount({session: listening, spans: true})).text()).toContain('All projects')
    })
})

describe('its summary line and Details (ORR-1220)', () => {
    const doing = (id: string) => ({id, title: `Issue ${id}`, column: 'in-progress', kind: 'started'}) as SessionWork['issues'][number]

    it('says the issue it is on in the summary, with a count of the others', async () => {
        const wrapper = await mount({session: session(), work: {issues: [doing('SHO-1'), doing('SHO-4')], signals: []}})
        const now = wrapper.find('[data-testid="session-now"]')
        expect(now.attributes('href')).toBe('/p/shop/issues/SHO-1')
        expect(now.text()).toContain('Issue SHO-1')
        expect(now.text()).toContain('+1')
    })

    it('keeps its details folded until its name is pressed', async () => {
        const wrapper = await mount({session: session({cwd: '/Users/ada/shop'})})
        const folded = () => wrapper.find('[data-testid="session-details"]').attributes('style')?.includes('display: none') ?? false
        const toggle = wrapper.find('button[aria-label="Details for shop · Brokk"]')
        expect(folded()).toBe(true)
        expect(toggle.attributes('aria-expanded')).toBe('false')
        await toggle.trigger('click')
        expect(folded()).toBe(false)
        expect(toggle.attributes('aria-expanded')).toBe('true')
    })

    it('opens them for the one a link points at', async () => {
        const wrapper = await mountSuspended(SessionCard, {props: {project: 'shop', session: session(), lit: true}})
        mounted.push(wrapper as VueWrapper)
        expect(wrapper.find('[data-testid="session-details"]').attributes('style') ?? '').not.toContain('display: none')
    })
})

describe('what a session is on', () => {
    const issue = (id: string, kind: string) => ({id, title: `Issue ${id}`, column: kind === 'started' ? 'in-progress' : 'done', kind}) as SessionWork['issues'][number]
    const signal = (id: number, over: object) => ({id, project: 'shop', created_by: 'claude', created_at: new Date().toISOString(), ...over}) as SessionWork['signals'][number]

    it('lists its issues in progress, and folds the rest it worked on under them', async () => {
        const wrapper = await mount({session: session(), work: {issues: [issue('SHO-1', 'started'), issue('SHO-2', 'done'), issue('SHO-3', 'done')], signals: []}})
        expect(wrapper.find('a[href="/p/shop/issues/SHO-1"]').text()).toContain('Issue SHO-1')
        expect(wrapper.text()).toContain('2 more it worked on')
        expect(wrapper.text()).not.toContain('Nothing in progress')
    })

    it("says when nothing's in progress", async () => {
        const wrapper = await mount({session: session(), work: {issues: [issue('SHO-2', 'done')], signals: []}})
        expect(wrapper.text()).toContain('Nothing in progress.')
    })

    it('says the latest thing it was sent, with the rest under it', async () => {
        const wrapper = await mount({session: session(), work: {issues: [], signals: [
            signal(3, {kind: 'message', note: 'Stop for today', via: 'chat'}),
            signal(2, {kind: 'comment', issue: 'SHO-1'}),
            signal(1, {kind: 'focus', issue: 'SHO-2'}),
        ]}})
        const summary = wrapper.find('summary').text()
        expect(summary).toContain("Last sent:")
        expect(summary).toContain("Agent's message via chat: Stop for today")
        expect(wrapper.text()).toContain("Agent's comment on SHO-1")
        expect(wrapper.text()).toContain('Agent: focus on SHO-2')
    })

    it('says a scheduled message as one', async () => {
        const wrapper = await mount({session: session(), work: {issues: [], signals: [signal(1, {kind: 'message', schedule: 4, note: 'Pick one'})]}})
        expect(wrapper.find('summary').text()).toContain("Agent's scheduled message")
    })
})
