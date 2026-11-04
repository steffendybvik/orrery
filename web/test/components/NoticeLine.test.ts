import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended as mountIt, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody} from 'h3'
import type {Notice, NoticeChange} from '#shared/roadmap'
import type {NoticeRow} from '~/composables/useInbox'
import NoticeHistory from '~/components/NoticeHistory.vue'
import NoticeLine from '~/components/NoticeLine.vue'

// Notifications (ORR-866): a line in the list says what happened on an issue that day (its status, a PR merged) or, for one
// waiting on the owner, the question; its history pane shows every notice and status change, newest first, and clears them.
const cleared: unknown[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/notices', () => [])
registerEndpoint('/api/notices/clear', {method: 'POST', handler: async event => {
    cleared.push(await readBody(event))
    return {cleared: 1}
}})

const notice = (id: number, at: string, more: Partial<Notice> = {}) =>
    ({id, project: 'shop', issue: 'SHO-1', title: 'Till', body: 'Done.', created_by: 'claude', created_at: at, updated_at: at, ...more}) as Notice
const change = (id: number, at: string, before: string, after: string): NoticeChange =>
    ({id, project: 'shop', issue: 'SHO-1', before, after, created_by: 'claude', session_name: 'orrery · Brokk', created_at: at})
const row = (notices: Notice[], more: Partial<NoticeRow> = {}): NoticeRow => ({
    key: 'shop/SHO-1', project: 'shop', issue: 'SHO-1', title: 'Till', notices, latest: notices[0]!.created_at, waiting: false, unread: false, ...more,
})

const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}
const mounted: VueWrapper[] = []
const mountSuspended: typeof mountIt = async (...args) => {
    const wrapper = await mountIt(...args)
    mounted.push(wrapper as VueWrapper)
    return wrapper
}
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})
beforeEach(() => {
    cleared.splice(0)
    clearNuxtState(['notices', 'notice-lists', 'notice-changes', 'notices-hidden'])
})

describe('a line in Notifications', () => {
    it('says a pull request merged, with the notice count to clear', async () => {
        const merged = notice(2, '2026-11-04T10:00:00Z', {created_by: 'orrery', body: '[#12](https://x/12) was merged into main.'})
        const wrapper = await mountSuspended(NoticeLine, {props: {row: row([merged, notice(1, '2026-11-04T09:00:00Z')], {unread: true}), selected: false, project: 'Shop'}})
        expect(wrapper.text()).toContain('#12 merged')
        expect(wrapper.text()).toContain('Shop')
        expect(wrapper.text()).toContain('SHO-1')
        expect(wrapper.find('[data-state]').attributes('data-state')).toBe('unread')
        expect(wrapper.find('button[aria-label="Clear these 2"]').exists()).toBe(true)
        await wrapper.find('button[aria-label="SHO-1: Till"]').trigger('click')
        await wrapper.find('button[aria-label="Clear these 2"]').trigger('click')
        expect(wrapper.emitted('select')).toHaveLength(1)
        expect(wrapper.emitted('clear')).toHaveLength(1)
    })

    it('says the first line of a plain comment, and nothing to clear once it is cleared', async () => {
        const wrapper = await mountSuspended(NoticeLine, {props: {row: row([notice(1, '2026-11-04T09:00:00Z', {body: 'Blockers:\n- **The till** sticks', cleared: true})]), selected: true}})
        expect(wrapper.text()).toContain('The till sticks')
        expect(wrapper.find('[data-state]').attributes('data-state')).toBe('read')
        expect(wrapper.find('button[aria-current="true"]').exists()).toBe(true)
        expect(wrapper.find('button[aria-label^="Clear"]').exists()).toBe(false)
    })

    it('leads with the question on one waiting on the owner, with how many more and a PR merged since', async () => {
        const asked = notice(3, '2026-11-04T09:00:00Z', {body: 'I looked.\n\n**Should the till round to 5 cents?**', asks: 'decision'})
        useInbox().lists.value.inbox.items = [notice(4, '2026-11-04T11:00:00Z', {created_by: 'orrery', body: '[#13](https://x/13) was merged into main.'})]
        const wrapper = await mountSuspended(NoticeLine, {props: {row: row([asked, notice(2, '2026-11-04T08:00:00Z', {asks: 'feedback'})], {waiting: true}), selected: false}})
        expect(wrapper.text()).toContain('Should the till round to 5 cents?')
        expect(wrapper.text()).toContain('#13 merged since')
        expect(wrapper.text()).toContain('+1 more')
        expect(wrapper.find('[data-state]').attributes('data-state')).toBe('waiting')
    })

    it('says where a day\'s status changes took the issue', async () => {
        useInbox().changes.value = [change(1, '2026-11-04T09:30:00Z', 'todo', 'in-progress'), change(2, '2026-11-04T09:40:00Z', 'in-progress', 'in-review')]
        const wrapper = await mountSuspended(NoticeLine, {props: {row: row([notice(1, '2026-11-04T09:00:00Z')]), selected: false}})
        expect(wrapper.find('[aria-label="to"]').exists()).toBe(true)
        expect(wrapper.text()).not.toContain('Done.')
    })
})

describe('a line\'s history', () => {
    it('lists the notices and status changes newest first, and clears one or all', async () => {
        useInbox().changes.value = [change(9, '2026-11-04T09:30:00Z', 'todo', 'in-progress')]
        const notices = [
            notice(2, '2026-11-04T10:00:00Z', {body: 'Second **word**', session_name: 'orrery · Brokk'}),
            notice(1, '2026-11-04T09:00:00Z', {body: 'Should it? Pick one.', asks: 'decision', answered: true}),
        ]
        const wrapper = await mountSuspended(NoticeHistory, {props: {row: row(notices), project: 'Shop'}})
        expect(wrapper.find('h2').text()).toBe('Till')
        expect(wrapper.find('a[href$="/issues/SHO-1"]').exists()).toBe(true)
        const entries = wrapper.findAll('ol > li').map(li => li.text())
        expect(entries).toHaveLength(3)
        expect(entries[0]).toContain('orrery · Brokk')
        expect(entries[0]).toContain('Second word')
        expect(entries[1]).toContain('orrery · Brokk')
        expect(entries[2]).toContain('Answered')
        await wrapper.findAll('button').find(b => b.text() === 'Clear these 2')!.trigger('click')
        await settle()
        expect(cleared).toEqual([{ids: [2, 1], proposals: []}])
        await wrapper.findAll('button').find(b => b.text() === 'Clear this one')!.trigger('click')
        await settle()
        expect(cleared[1]).toEqual({ids: [2], proposals: []})
        await wrapper.find('button[aria-label="Close this notification"]').trigger('click')
        expect(wrapper.emitted('back')).toHaveLength(1)
    })
})
