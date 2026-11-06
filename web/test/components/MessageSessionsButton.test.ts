import {afterEach, describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import type {Session} from '#shared/roadmap'
import MessageSessionsButton from '~/components/MessageSessionsButton.vue'

// The header's Message sessions button (ORR-937): there on every page while a session listens, and it opens the dialog
// that messages them all.
describe('MessageSessionsButton', () => {
    afterEach(() => {
        useRoadmaps().sessions.value = {}
        useMessageSessions().all.value = false
    })

    it('hides with nobody listening, and opens Message sessions once one does', async () => {
        const deaf = {id: 's2', name: 'cellar door', project: 'pantry', listening: false} as unknown as Session
        useRoadmaps().sessions.value = {pantry: [deaf]}
        const wrapper = await mountSuspended(MessageSessionsButton)
        expect(wrapper.find('button').exists()).toBe(false)

        const shelves = {id: 's1', name: 'kitchen shelves', project: 'greenhouse', listening: true} as unknown as Session
        useRoadmaps().sessions.value = {greenhouse: [shelves], pantry: [shelves, deaf]}
        await nextTick()
        const button = wrapper.find('button')
        expect(button.attributes('aria-label')).toBe('Message sessions (1 listening)')
        await button.trigger('click')
        expect(useMessageSessions().all.value).toBe(true)
    })
})
