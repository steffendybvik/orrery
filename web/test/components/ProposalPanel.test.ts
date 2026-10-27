import {beforeEach, describe, expect, it, vi} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody, setResponseStatus} from 'h3'
import type {Choice, Issue} from '#shared/roadmap'
import ProposalPanel from '~/components/ProposalPanel.vue'

const CHOICES: Choice[] = [
    {key: 'store', question: 'Where does it live?', pick: 'one', recommended: ['A'], options: [{key: 'A', title: 'SQLite'}, {key: 'B', title: 'Postgres'}]},
]

// What the panel sent, as the server got it.
let sent: {path: string, method: string, actor?: string, body: unknown}[] = []
let failing = false
registerEndpoint('/api/owner', () => ({name: 'steffen', display: 'Steffen', named: true}))
for (const [path, method] of [['/decide', 'POST'], ['', 'PATCH']] as const) {
    registerEndpoint(`/api/projects/orrery/issues/ORR-1${path}`, {method, handler: async event => {
        if (failing) {
            setResponseStatus(event, 409)
            return {message: 'It was decided in another tab'}
        }
        sent.push({path, method, actor: getHeader(event, 'orrery-actor'), body: await readBody(event)})
        return {}
    }})
}
beforeEach(() => {
    sent = []
    failing = false
})

const proposal = (fields: Partial<Issue> = {}) => ({id: 'ORR-1', kind: 'proposed', proposal: 'pending', choices: [], ...fields}) as Issue

async function mount(issue: Issue) {
    const wrapper = await mountSuspended(ProposalPanel, {props: {project: 'orrery', issue}})
    const button = (text: string) => {
        const found = wrapper.findAll('button').find(b => b.text() === text)
        if (!found) throw new Error(`No ${text} button`)
        return found
    }
    return {wrapper, button}
}

describe('ProposalPanel', () => {
    it('approves with the recommended picks and the note, as the owner', async () => {
        const {wrapper, button} = await mount(proposal({choices: CHOICES}))
        await wrapper.find('textarea').setValue('  Keep it simple  ')
        await button('Approve').trigger('click')
        await vi.waitFor(() => expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(''))
        expect(sent).toEqual([{path: '/decide', method: 'POST', actor: 'steffen', body: {decision: 'approved', picks: {store: ['A']}, note: 'Keep it simple'}}])
    })

    it('sends what the owner ticked instead of the recommendation', async () => {
        const {wrapper, button} = await mount(proposal({choices: CHOICES}))
        await wrapper.findAll('input')[1]!.trigger('change')
        await button('Approve').trigger('click')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]?.body).toEqual({decision: 'approved', picks: {store: ['B']}})
    })

    it('rejects without picks, and explores an option as asking for changes', async () => {
        const {button} = await mount(proposal({choices: CHOICES}))
        await button('Reject').trigger('click')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        await button('Explore').trigger('click')
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent.map(s => s.body)).toEqual([{decision: 'rejected'}, {decision: 'changes', explore: {choice: 'store', option: 'A'}}])
    })

    it('shows the error and keeps the note when the decision fails', async () => {
        failing = true
        const {wrapper, button} = await mount(proposal())
        await wrapper.find('textarea').setValue('Why not')
        await button('Approve').trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('It was decided in another tab'))
        expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('Why not')
    })

    it('shows a decision as a summary, with Change decision bringing the controls back', async () => {
        const {wrapper, button} = await mount(proposal({proposal: 'changes', choices: CHOICES, picks: {store: ['B']}, decided_by: 'steffen', decided_at: '2026-10-27T08:00:00Z', decision_note: 'Try Postgres'}))
        expect(wrapper.text()).toContain('Changes asked for')
        expect(wrapper.text()).toContain('Where does it live? → Postgres')
        expect(wrapper.text()).toContain('“Try Postgres”')
        expect(wrapper.find('textarea').exists()).toBe(false)
        await button('Change decision').trigger('click')
        expect(wrapper.find('textarea').exists()).toBe(true)
        expect(wrapper.findAll('input:checked')).toHaveLength(1)
    })

    it('once approved and open, says it is work and can put it up again', async () => {
        const {wrapper, button} = await mount(proposal({proposal: undefined, kind: 'todo', decided_by: 'steffen', decided_at: '2026-10-27T08:00:00Z'}))
        expect(wrapper.text()).toContain("It's on the roadmap")
        await button('Put it up again').trigger('click')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent).toEqual([{path: '', method: 'PATCH', actor: 'steffen', body: {proposal: 'pending'}}])
    })

    it('shows nothing for an issue that was never a proposal', async () => {
        const {wrapper} = await mount(proposal({proposal: undefined, kind: 'todo'}))
        expect(wrapper.find('section').exists()).toBe(false)
    })
})
