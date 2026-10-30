import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import NotFound from '~/components/NotFound.vue'

// What wasn't found is a heading: an h2 under the page's own h1, or the h1 on a page with none (ORR-695).
describe('NotFound', () => {
    it.each([[undefined, 'H2'], ['h1', 'H1']] as const)('with heading %s is an %s', async (heading, tag) => {
        const wrapper = await mountSuspended(NotFound, {props: {to: '/mine', back: 'Go to My issues', heading}, slots: {default: () => 'No issue PRM-9'}})
        expect(wrapper.find(tag.toLowerCase()).text()).toBe('No issue PRM-9')
    })
})
