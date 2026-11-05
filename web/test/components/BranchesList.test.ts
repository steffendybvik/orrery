import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getQuery, setResponseStatus} from 'h3'
import type {AllBranches, RepoBranch} from '#shared/roadmap'
import BranchesList from '~/components/BranchesList.vue'

// Branches (ORR-793): a card per repo, each branch with its issue, PR, verdict and age, and Remove… only on one that reads
// as remove, and only after asking (ORR-866).
let answer: AllBranches | 'fail'
const removed: {repo: string, name: string}[] = []
let refuse = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/pulls/branches', {method: 'GET', handler: event => {
    if (answer === 'fail') {
        setResponseStatus(event, 502)
        return {message: 'GitHub is down'}
    }
    return answer
}})
registerEndpoint('/api/pulls/branches', {method: 'DELETE', handler: event => {
    if (refuse) {
        setResponseStatus(event, 409)
        return {message: 'It has commits since'}
    }
    const {repo, name} = getQuery(event) as {repo: string, name: string}
    removed.push({repo, name})
    if (answer !== 'fail') answer = {...answer, branches: answer.branches.filter(b => b.name !== name)}
    return {ok: true}
}})

const branch = (over: Partial<RepoBranch>): RepoBranch => ({
    repo: 'you/shop', name: 'feat/sho-1-a', sha: 'abcdef1234567', committed_at: '2026-10-30T00:00:00Z', ahead: 0,
    verdict: 'keep', why: 'Its pull request is open', carry_on: false, ...over,
})
const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    removed.splice(0)
    refuse = false
})
async function mount(given: AllBranches | 'fail') {
    answer = given
    const wrapper = await mountSuspended(BranchesList)
    mounted.push(wrapper)
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
    return wrapper
}
const rows = (wrapper: VueWrapper) => wrapper.findAll('ul[aria-label="Repos"] > li li')

describe('Branches', () => {
    it('counts each verdict and shows each branch with its issue, PR and commits', async () => {
        const wrapper = await mount({
            repos: [{repo: 'you/shop', projects: ['shop'], base: 'main', token: true}],
            branches: [
                branch({name: 'feat/sho-1-a', issue: {project: 'shop', id: 'SHO-1', title: 'Till', kind: 'done'}, pull: {number: 4, url: 'https://x/4', state: 'merged'}, verdict: 'remove', why: 'Its pull request merged', ahead: 3}),
                branch({name: 'feat/sho-2-b', verdict: 'look', why: 'No pull request', ahead: 1}),
                branch({name: 'main', verdict: 'keep', why: 'The default branch, or a release being prepared'}),
            ],
        })
        expect(wrapper.text()).toContain('3 branches: 1 to look at, 1 to remove, 1 to keep')
        expect(wrapper.text()).toContain('commits counted against main')
        const [merged, lone] = rows(wrapper)
        expect(merged!.text()).toContain('SHO-1')
        expect(merged!.text()).toContain('#4 merged')
        expect(merged!.text()).toContain('3 commits not in main (a squash merge leaves them reading so)')
        expect(merged!.text()).toContain('abcdef1')
        expect(lone!.text()).toContain('no pull request')
        expect(lone!.text()).toContain('1 commit not in main')
        // Only the one that reads as remove can be removed.
        expect(wrapper.findAll('button').filter(b => b.text() === 'Remove…')).toHaveLength(1)
    })

    it('removes a branch only once asked, then reads the list again', async () => {
        const wrapper = await mount({
            repos: [{repo: 'you/shop', projects: ['shop'], base: 'main', token: true}],
            branches: [branch({name: 'feat/old', verdict: 'remove', why: 'It has nothing left to bring in'}), branch({name: 'main'})],
        })
        await wrapper.findAll('button').find(b => b.text() === 'Remove…')!.trigger('click')
        expect(wrapper.text()).toContain('Remove feat/old from GitHub?')
        expect(removed).toEqual([])
        const confirm = wrapper.findAll('button').find(b => /^Remove$|Confirm/.test(b.text()))!
        await confirm.trigger('click')
        await new Promise(resolve => setTimeout(resolve, 20))
        await flushPromises()
        expect(removed).toEqual([{repo: 'you/shop', name: 'feat/old'}])
        expect(wrapper.text()).toContain('1 branch: 0 to look at, 0 to remove, 1 to keep')
    })

    it('says why GitHub refused a removal, on the branch', async () => {
        refuse = true
        const wrapper = await mount({
            repos: [{repo: 'you/shop', projects: ['shop'], base: 'main', token: true}],
            branches: [branch({name: 'feat/old', verdict: 'remove', why: 'Its pull request merged'})],
        })
        await wrapper.findAll('button').find(b => b.text() === 'Remove…')!.trigger('click')
        await wrapper.findAll('button').find(b => /^Remove$|Confirm/.test(b.text()))!.trigger('click')
        await new Promise(resolve => setTimeout(resolve, 20))
        await flushPromises()
        expect(rows(wrapper)[0]!.text()).toContain('It has commits since')
    })

    it('says what a repo read without a token, cut short or failed can\'t tell', async () => {
        const wrapper = await mount({
            repos: [
                {repo: 'you/bare', projects: ['bare'], base: null, token: false, cut: 100},
                {repo: 'you/gone', projects: ['gone'], base: null, token: false, error: 'Not found on GitHub'},
            ],
            branches: [branch({repo: 'you/bare', name: 'feat/x', committed_at: null, ahead: null})],
        })
        expect(wrapper.text()).toContain('read without a token, so no age or commit count')
        expect(wrapper.text()).toContain('only the first 100 read')
        expect(wrapper.text()).toContain('Not found on GitHub')
        expect(rows(wrapper)[0]!.text()).not.toContain('not in')
    })

    it('says when no project has a repo, and when GitHub can\'t be read', async () => {
        expect((await mount({repos: [], branches: []})).text()).toContain('No project points at a repo on GitHub.')
        expect((await mount('fail')).text()).toContain('GitHub is down')
    })
})
