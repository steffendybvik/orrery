import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import ErrorBadge from '~/components/ErrorBadge.vue'

// An error is never told by its colour alone: the count comes with a warning sign.
describe('ErrorBadge', () => {
    it('shows the count with a warning sign', async () => {
        const wrapper = await mountSuspended(ErrorBadge, {props: {count: 3}})
        expect(wrapper.text()).toBe('3')
        expect(wrapper.find('svg').exists()).toBe(true)
        wrapper.unmount()
    })
})
