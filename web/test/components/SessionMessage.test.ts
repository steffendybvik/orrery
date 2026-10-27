import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody} from 'h3'
import type {Session} from '#shared/roadmap'
import SessionMessage from '~/components/SessionMessage.vue'

// A message to one session from a preset: picking one fills the box to tweak, and the send says which it was;
// emptying the box lets it go, so the next words are plain.
let sent: unknown[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/greenhouse/presets', () => [
    {id: 1, project: null, name: 'Review', text: 'Read the diff.'},
    {id: 2, project: 'greenhouse', name: 'Release', text: 'Cut the release.'},
])
registerEndpoint('/api/projects/greenhouse/sessions/shelves/message', {method: 'POST', handler: async event => {
    sent.push(await readBody(event))
    return {}
}})

const session = {id: 'shelves', name: 'shelves', project: 'greenhouse', state: 'idle', listening: true, since: '', started_at: ''} as Session
const mounted: VueWrapper[] = []
beforeEach(() => sent = [])
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount() {
    const wrapper = await mountSuspended(SessionMessage, {props: {session, project: 'greenhouse'}, attachTo: document.body})
    mounted.push(wrapper)
    const pick = async (name: string) => {
        await wrapper.find('button[aria-label="Pick a preset"]').trigger('click')
        await vi.waitFor(() => expect(wrapper.findAll('[role="menuitem"]')).toHaveLength(2))
        await wrapper.findAll('[role="menuitem"]').find(b => b.text().endsWith(name))!.trigger('click')
    }
    return {wrapper, pick, box: wrapper.find('textarea')}
}

describe('SessionMessage', () => {
    it("sends a preset's text, tweaked, saying which preset it came from", async () => {
        const {wrapper, pick, box} = await mount()
        await pick('Release')
        expect((box.element as HTMLTextAreaElement).value).toBe('Cut the release.')
        expect(wrapper.find('button[aria-label="From the preset Release"]').exists()).toBe(true)
        await box.setValue('Cut the release, for rc.9.')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toEqual({text: 'Cut the release, for rc.9.', preset: 2})
        // Sent, the box is empty and the next message is plain words.
        await box.setValue('Thanks')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent[1]).toEqual({text: 'Thanks'})
    })

    it('lets the preset go once the box is emptied', async () => {
        const {wrapper, pick, box} = await mount()
        await pick('Review')
        await box.setValue('')
        await box.setValue('Look at the hinges')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toEqual({text: 'Look at the hinges'})
    })
})
