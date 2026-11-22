import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {setResponseStatus} from 'h3'
import type {Issue, Session} from '#shared/roadmap'
import IssueClaim from '~/components/IssueClaim.vue'

// Who holds an issue, beside its assignee (ORR-657): claiming it, letting go and the owner taking over. With one
// person it shows nothing; the server says who may, and why not.
let sent: string[] = []
let refuse = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
for (const method of ['POST', 'DELETE']) {
    registerEndpoint('/api/projects/greenhouse/issues/GRE-1/claim', {method, handler: event => {
        sent.push(method)
        if (refuse) {
            setResponseStatus(event, 409)
            return {statusCode: 409, message: 'Ada holds it'}
        }
        return {}
    }})
}

const issue = (more: Record<string, unknown> = {}) => ({id: 'GRE-1', title: 'Water', ...more}) as unknown as Issue
const people = [{id: 'skoll', name: 'Sköll', role: 'owner'}, {id: 'ada', name: 'Ada', role: 'member'}, {id: 'bo', name: 'Bo', role: 'member'}]
const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    refuse = false
    useState('people').value = people
    useState('acting').value = null
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(task: Issue, as: string | null = null, worker?: Session) {
    useState('acting').value = as
    const wrapper = await mountSuspended(IssueClaim, {props: {issue: task, project: 'greenhouse', worker}})
    mounted.push(wrapper)
    return wrapper
}
const buttons = (wrapper: VueWrapper) => wrapper.findAll('button').map(b => b.text())

describe('IssueClaim', () => {
    it('shows nothing with one person', async () => {
        useState('people').value = [people[0]]
        expect((await mount(issue())).text()).toBe('')
    })

    it("lets the owner claim an unclaimed one, assigned or not, and says nobody's on it", async () => {
        const wrapper = await mount(issue({assignee: 'Ada'}))
        expect(wrapper.text()).toContain("Nobody's taken it up")
        expect(buttons(wrapper)).toEqual(['Claim'])
        await wrapper.get('button').trigger('click')
        await vi.waitFor(() => expect(sent).toEqual(['POST']))
    })

    it('lets a member claim one assigned to them or to no one, not to someone else', async () => {
        expect(buttons(await mount(issue({assignee: 'ADA'}), 'ada'))).toEqual(['Claim'])
        expect(buttons(await mount(issue(), 'ada'))).toEqual(['Claim'])
        expect(buttons(await mount(issue({assignee: 'bo'}), 'ada'))).toEqual([])
    })

    it('says who holds it, since when and the session on it; its holder lets go', async () => {
        const wrapper = await mount(issue({claimed_by: 'ada', claimed_at: new Date().toISOString()}), 'ada', {name: 'orrery · Var'} as Session)
        expect(wrapper.text()).toMatch(/Held by Ada for .+, orrery · Var on it/)
        expect(buttons(wrapper)).toEqual(['Let go'])
        await wrapper.get('button').trigger('click')
        await vi.waitFor(() => expect(sent).toEqual(['DELETE']))
    })

    it("lets the owner take over or let go of another's, and a member neither", async () => {
        expect(buttons(await mount(issue({claimed_by: 'ada'})))).toEqual(['Take over', 'Let go'])
        expect(buttons(await mount(issue({claimed_by: 'ada'}), 'bo'))).toEqual([])
    })

    it('says why the server refused, and is ready again after', async () => {
        refuse = true
        const wrapper = await mount(issue({claimed_by: 'ada'}))
        await wrapper.findAll('button').find(b => b.text() === 'Take over')!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Ada holds it'))
        expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    })
})
