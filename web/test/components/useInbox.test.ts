import {beforeEach, describe, expect, it} from 'vitest'
import {registerEndpoint} from '@nuxt/test-utils/runtime'
import {getQuery, readBody} from 'h3'
import type {Notice} from '#shared/roadmap'

// The bell and the notifications page (useInbox): what's new since the owner last looked, what waits on them, the
// page's lists a page at a time, and clearing (ORR-586).
const SEEN = '2026-10-29T10:00:00.000Z'
const notice = (id: number, at: string, more: Partial<Notice> = {}) =>
    ({id, project: 'greenhouse', issue: `GRE-${id}`, body: 'Done.', created_by: 'claude', created_at: at, updated_at: at, ...more}) as unknown as Notice

let bell: Notice[] = []
let pages: Record<string, Notice[]> = {}
const asked: {list: string, before?: string}[] = []
const cleared: unknown[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/notices', event => {
    const {list, before} = getQuery(event) as {list?: string, before?: string}
    if (!list) return bell
    asked.push({list, before})
    return pages[`${list}${before ? `<${before}` : ''}`] ?? []
})
registerEndpoint('/api/notices/clear', {method: 'POST', handler: async event => {
    cleared.push(await readBody(event))
    return {cleared: 1}
}})

beforeEach(() => {
    bell = []
    pages = {}
    asked.length = 0
    cleared.length = 0
    localStorage.setItem('orrery-notices-seen', SEEN)
    clearNuxtState(['notices', 'notice-lists', 'notices-hidden', 'notices-seen', 'owner'])
})

describe('useInbox', () => {
    it('counts what came since the owner last looked, and what waits on them until answered', () => {
        const inbox = useInbox()
        inbox.notices.value = [
            notice(3, '2026-10-29T11:00:00.000Z'),
            notice(2, '2026-10-29T09:00:00.000Z', {asks: 'decision'}),
            notice(1, '2026-10-29T08:00:00.000Z'),
        ]
        expect(inbox.unread.value).toBe(2)
        expect(inbox.waiting.value.map(n => n.id)).toEqual([2])
        expect(inbox.read.value).toBe(1)
        inbox.seen()
        expect(localStorage.getItem('orrery-notices-seen')).toBe('2026-10-29T11:00:00.000Z')
        // Still waiting, so still counted.
        expect(inbox.unread.value).toBe(1)
        expect(isWaiting(notice(4, SEEN, {asks: 'feedback', answered: true}))).toBe(false)
    })

    it('puts one that arrives in the bell and in the loaded list it belongs to', async () => {
        const inbox = useInbox()
        pages.inbox = [notice(1, '2026-10-29T08:00:00.000Z')]
        await inbox.load('inbox')
        inbox.arrived(notice(2, '2026-10-29T11:00:00.000Z'))
        inbox.arrived(notice(3, '2026-10-29T11:01:00.000Z', {asks: 'decision'}))
        expect(inbox.notices.value.map(n => n.id)).toEqual([3, 2])
        expect(inbox.lists.value.inbox.items.map(n => n.id)).toEqual([2, 1])
        // Waiting isn't loaded, so it fills when it is.
        expect(inbox.lists.value.waiting.items).toEqual([])
    })

    it('loads a list a page at a time, the next from its oldest comment', async () => {
        const inbox = useInbox()
        pages.inbox = Array.from({length: 50}, (_, i) => notice(100 - i, SEEN))
        await inbox.load('inbox')
        expect(inbox.lists.value.inbox).toMatchObject({more: true, loaded: true})
        pages['inbox<51'] = [notice(50, SEEN)]
        await inbox.load('inbox', true)
        expect(asked.at(-1)).toEqual({list: 'inbox', before: '51'})
        expect(inbox.lists.value.inbox.items).toHaveLength(51)
        expect(inbox.lists.value.inbox.more).toBe(false)
    })

    it('clears the read ones, or those picked, and reads the bell again', async () => {
        const inbox = useInbox()
        const old = notice(1, '2026-10-29T08:00:00.000Z')
        const fresh = notice(2, '2026-10-29T11:00:00.000Z')
        inbox.notices.value = [fresh, old]
        bell = [fresh]
        await inbox.clear()
        expect(cleared).toEqual([{before: SEEN}])
        expect(inbox.notices.value.map(n => n.id)).toEqual([2])

        const proposal = notice(3, SEEN, {proposal: 'pending'} as Partial<Notice>)
        inbox.notices.value = [fresh, proposal]
        bell = []
        await inbox.clear([fresh, proposal])
        expect(cleared.at(-1)).toEqual({ids: [2], proposals: [{project: 'greenhouse', issue: 'GRE-3'}]})
        expect(inbox.notices.value).toEqual([])
    })
})
