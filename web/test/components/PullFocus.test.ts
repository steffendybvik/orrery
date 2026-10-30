import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {OpenPull} from '#shared/roadmap'
import PullFocus from '~/components/PullFocus.vue'

// Focus on this on the Pull requests page (ORR-607): the popover opens with the note filled in from the PR's state,
// the owner can change it, and Send posts it as a focus on the PR's issue that may start a session.
const sent: {path: string, body: {note: string, start: boolean}, actor?: string}[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/greenhouse/issues/GRN-4/focus', {method: 'POST', handler: async event => {
    sent.push({path: event.path, body: await readBody(event), actor: event.headers.get('orrery-actor') ?? undefined})
    setResponseStatus(event, 201)
    return {signal: {id: 1, project: 'greenhouse', issue: 'GRN-4', kind: 'focus', delivered_to: ['orrery · Shelves']}, listeners: 1}
}})
registerEndpoint('/api/projects/greenhouse/issues/GRN-5/focus', {method: 'POST', handler: event => {
    setResponseStatus(event, 404)
    return {message: 'No issue GRN-5'}
}})

const pull = (over: Partial<OpenPull> = {}) => ({
    number: 12, title: 'Water the ferns', url: 'https://github.com/you/greenhouse/pull/12', branch: 'grn-4-ferns', base: 'main',
    author: 'skoll', state: 'failing', created_at: '2026-10-29T10:00:00Z', updated_at: '2026-10-29T10:00:00Z', repo: 'you/greenhouse',
    issue: {project: 'greenhouse', id: 'GRN-4', title: 'Ferns'}, ...over,
}) as OpenPull
const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    sent.splice(0)
})

async function mount(over: Partial<OpenPull> = {}) {
    const p = pull(over)
    const wrapper = await mountSuspended(PullFocus, {props: {pull: p, issue: p.issue!}, attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}

describe('PullFocus', () => {
    it("opens with the note its state asks for, and sends what's in the box as the owner's, starting a session", async () => {
        const wrapper = await mount()
        await wrapper.find('button').trigger('click')
        const box = wrapper.find('textarea')
        expect((box.element as HTMLTextAreaElement).value).toBe('Its PR #12 (into main, https://github.com/you/greenhouse/pull/12) fails its checks: read them (gh pr checks 12), fix what fails and push.')
        await box.setValue(`${(box.element as HTMLTextAreaElement).value}\nThe e2e is flaky, rerun it once.`)
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.find('button').text()).toBe('Sent to orrery · Shelves')
        expect(sent).toHaveLength(1)
        expect(sent[0]!.body.start).toBe(true)
        expect(sent[0]!.body.note).toMatch(/fails its checks.*\nThe e2e is flaky, rerun it once\.$/s)
        expect(sent[0]!.actor).toBe('skoll')
        expect(wrapper.find('textarea').exists()).toBe(false)
    })

    it('fills a healthy PR with a note to take it forward', async () => {
        const wrapper = await mount({state: 'checking'})
        await wrapper.find('button').trigger('click')
        expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toMatch(/^Look at its PR #12 .* and take it forward/)
    })

    it("says why it couldn't send, and stays open", async () => {
        const wrapper = await mount({issue: {project: 'greenhouse', id: 'GRN-5', title: 'Moss'}})
        await wrapper.find('button').trigger('click')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.text()).toContain('No issue GRN-5')
        expect(wrapper.find('textarea').exists()).toBe(true)
    })
})
