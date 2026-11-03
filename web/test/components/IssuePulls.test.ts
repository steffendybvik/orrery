import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {IssuePulls as Answer} from '#shared/roadmap'
import IssuePulls from '~/components/IssuePulls.vue'

// An issue's page keeps every PR it has had (ORR-795): open first, then how the rest ended and where they went.
let answer: Answer
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/shop/issues/SHO-1/pulls', () => answer)

const open = {number: 9, title: 'Still going', url: 'https://x/9', branch: 'feat/sho-1-b', base: 'v2', author: 'claude', state: 'ready' as const, created_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z'}
const past = (number: number, state: 'merged' | 'closed' | 'open') => ({number, title: `Old ${number}`, url: `https://x/${number}`, branch: 'feat/sho-1-a', base: 'v1', author: 'claude', state, merged_at: state === 'merged' ? '2026-10-29T00:00:00Z' : null, updated_at: '2026-10-29T00:00:00Z'})

const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})
async function mount(given: Partial<Answer>) {
    answer = {repo: 'you/shop', pulls: [], done: [], token: true, checked_at: null, ...given}
    const wrapper = await mountSuspended(IssuePulls, {props: {project: 'shop', issue: 'SHO-1'}})
    mounted.push(wrapper)
    await new Promise(resolve => setTimeout(resolve, 20))
    await nextTick()
    return wrapper
}

describe('an issue\'s pull requests', () => {
    it('lists the open ones, then those merged and closed, with where each went', async () => {
        const wrapper = await mount({pulls: [open], done: [past(7, 'merged'), past(6, 'closed')]})
        expect(wrapper.findAll('li a').map(a => a.text())).toEqual(['#9 Still going', '#7 Old 7', '#6 Old 6'])
        const rows = wrapper.findAll('li').map(li => li.text())
        expect(rows[1]).toContain('Merged')
        expect(rows[1]).toContain('feat/sho-1-a → v1')
        expect(rows[2]).toContain('Closed')
        expect(wrapper.find('h2').text()).toContain('3')
    })

    it('still shows them with the repo gone, one open saying it was when last seen', async () => {
        const wrapper = await mount({repo: null, done: [past(7, 'open')]})
        expect(wrapper.text()).toContain('Open when last seen')
    })

    it('offers Send back only on what can still be fixed', async () => {
        const wrapper = await mount({pulls: [{...open, state: 'failing'}], done: [past(7, 'merged')]})
        expect(wrapper.findAll('button').filter(b => b.text() === 'Send back')).toHaveLength(1)
    })

    it('shows nothing for an issue with no PR', async () => {
        const wrapper = await mount({})
        expect(wrapper.find('section').exists()).toBe(false)
    })
})
