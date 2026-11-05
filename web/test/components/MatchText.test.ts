import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import MatchText from '~/components/MatchText.vue'

// A search's matches marked in a pull request's row (ORR-941).
describe('MatchText', () => {
    it('marks each word of the search, in any case, and nothing without one', async () => {
        const marked = async (text: string, q?: string) => (await mountSuspended(MatchText, {props: {text, q}})).findAll('mark').map(m => m.text())
        expect(await marked('Refund the card', 'card REFUND')).toEqual(['Refund', 'card'])
        expect(await marked('#788', '#788')).toEqual(['788'])
        expect(await marked('a (b) c', '(b)')).toEqual(['(b)'])
        expect(await marked('Refund the card')).toEqual([])
        expect((await mountSuspended(MatchText, {props: {text: 'Refund the card', q: 'card'}})).text()).toBe('Refund the card')
    })
})
