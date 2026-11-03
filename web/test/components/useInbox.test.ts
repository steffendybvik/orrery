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
const marked: unknown[] = []
registerEndpoint('/api/notices/read', {method: 'POST', handler: async event => {
    marked.push(await readBody(event))
    return {read: 1}
}})
registerEndpoint('/api/notices/clear', {method: 'POST', handler: async event => {
    cleared.push(await readBody(event))
    return {cleared: 1}
}})

beforeEach(() => {
    bell = []
    pages = {}
    asked.length = 0
    cleared.length = 0
    marked.length = 0
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
        expect(cleared).toEqual([{read: true}])
        expect(inbox.notices.value.map(n => n.id)).toEqual([2])

        const proposal = notice(3, SEEN, {proposal: 'pending'} as Partial<Notice>)
        inbox.notices.value = [fresh, proposal]
        bell = []
        await inbox.clear([fresh, proposal])
        expect(cleared.at(-1)).toEqual({ids: [2], proposals: [{project: 'greenhouse', issue: 'GRE-3'}]})
        expect(inbox.notices.value).toEqual([])
    })
})

describe('noticeDays', () => {
    const now = new Date(2026, 9, 31, 12)
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString()

    it('groups by day, newest first, one row per issue, with a total and an unread count', () => {
        const days = noticeDays([
            notice(1, at(30, 9), {issue: 'GRE-1', read: true}),
            notice(2, at(31, 8), {issue: 'GRE-2'}),
            notice(3, at(31, 10), {issue: 'GRE-2', read: true}),
            notice(4, at(31, 11), {issue: 'GRE-4', read: true}),
            notice(5, at(20, 11), {issue: 'GRE-2'}),
        ], now)
        expect(days.map(d => [d.label, d.total, d.unread])).toEqual([['Today', 3, 1], ['Yesterday', 1, 0], [expect.stringMatching(/20/), 1, 1]])
        expect(days[0]!.rows.map(r => [r.issue, r.notices.map(n => n.id), r.unread])).toEqual([['GRE-4', [4], false], ['GRE-2', [3, 2], true]])
    })

    it('keeps the same issue on two days as two rows, and marks one with a question waiting', () => {
        const days = noticeDays([
            notice(1, at(30, 9), {issue: 'GRE-1', asks: 'decision'}),
            notice(2, at(31, 8), {issue: 'GRE-1', read: true}),
        ], now)
        expect(days.map(d => d.rows.length)).toEqual([1, 1])
        expect(days[1]!.rows[0]!.waiting).toBe(true)
        expect(days[0]!.rows[0]!.waiting).toBe(false)
    })

    it('counts no proposal as unread, as it has no read state', () => {
        const [today] = noticeDays([notice(0, at(31, 9), {issue: 'GRE-9', asks: 'decision', proposal: {choices: 0}})], now)
        expect([today!.total, today!.unread, today!.rows[0]!.waiting, today!.rows[0]!.unread]).toEqual([1, 0, true, false])
    })
})

describe('reading a notice', () => {
    it('marks those unread, here and on the server, and leaves the bell counting what it did', async () => {
        const inbox = useInbox()
        const fresh = notice(2, '2026-10-29T11:00:00.000Z')
        const already = notice(3, '2026-10-29T12:00:00.000Z', {read: true})
        const proposal = notice(0, '2026-10-29T13:00:00.000Z', {issue: 'GRE-9', asks: 'decision', proposal: {choices: 0}})
        inbox.notices.value = [fresh, already, proposal]
        inbox.lists.value.inbox.items = [fresh, already]
        const counted = inbox.unread.value
        await inbox.markRead([fresh, already, proposal])
        expect(marked).toEqual([{ids: [2]}])
        expect(inbox.lists.value.inbox.items.every(n => n.read)).toBe(true)
        expect(inbox.unread.value).toBe(counted)
    })

    it('sends nothing when all of them are read already', async () => {
        await useInbox().markRead([notice(3, '2026-10-29T12:00:00.000Z', {read: true})])
        expect(marked).toEqual([])
    })
})

describe('what a notifications line says (ORR-803)', () => {
    const change = (id: number, before: string, after: string, at: string, issue = 'GRE-1') => ({id, project: 'greenhouse', issue, before, after, created_by: 'claude', created_at: at})

    it('reads a question: the bold one asking, else the last bold, else the first line', () => {
        expect(questionOf('**Where it stands:** fine.\n\n**Oak or pine?** I recommend oak.')).toBe('Oak or pine?')
        expect(questionOf('[#7](https://x.test/7) is ready, **and I held it**.\n\n**Say go, or merge [#7](https://x.test/7).**')).toBe('Say go, or merge #7.')
        expect(questionOf('**Blockers:**\n\nShall I go on with `this`')).toBe('Shall I go on with this')
        expect(questionOf('Sieved to a billion. How much memory may it use? **256 KB** would do.')).toBe('How much memory may it use?')
    })

    it('takes a line of Markdown down to its words', () => {
        expect(plainLine('\n\n- [x] **Done** in [#712](https://x.test/712)')).toBe('Done in #712')
        expect(plainLine('![Before](/api/uploads/1)\nAfter it')).toBe('After it')
    })

    it("knows orrery's own word for a merged pull request, and nobody else's", () => {
        const merged = '[#711](https://github.com/a/b/pull/711) was merged into `main` as `81bca68`.'
        expect(mergedPull({body: merged, created_by: 'orrery'})).toBe(711)
        expect(mergedPull({body: merged, created_by: 'claude'})).toBeNull()
        expect(mergedPull({body: 'Nothing merged.', created_by: 'orrery'})).toBeNull()
        expect(latestMerged([notice(2, SEEN, {body: 'Hm.'}), notice(1, SEEN, {body: merged, created_by: 'orrery'})])).toBe('#711')
    })

    it('comes to where a run of changes started and ended, or its last step if it came back', () => {
        expect(netChange([])).toBeNull()
        const there = [change(1, 'todo', 'in-progress', SEEN), change(2, 'in-progress', 'done', SEEN)]
        expect(netChange(there)).toEqual({before: 'todo', after: 'done'})
        expect(netChange([change(1, 'todo', 'in-progress', SEEN), change(2, 'in-progress', 'todo', SEEN)])).toEqual({before: 'in-progress', after: 'todo'})
    })

    it("gives a day's line that day's changes, and a waiting line those since it asked", () => {
        const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString()
        const asked = notice(1, at(30, 12), {issue: 'GRE-1', asks: 'decision'})
        const changes = [change(1, 'todo', 'in-progress', at(30, 9)), change(2, 'in-progress', 'done', at(31, 9)), change(3, 'todo', 'done', at(31, 9), 'GRE-2')]
        const [line] = noticeDays([notice(1, at(31, 10), {issue: 'GRE-1'})], new Date(2026, 9, 31, 12))[0]!.rows
        expect(rowChanges(line!, changes).map(c => c.id)).toEqual([2])
        expect(rowChanges(waitingRows([asked])[0]!, changes).map(c => c.id)).toEqual([2])
    })

    it('makes one waiting line an issue, its newest question leading', () => {
        const rows = waitingRows([notice(1, '2026-10-30T08:00:00.000Z', {issue: 'GRE-1'}), notice(2, '2026-10-31T08:00:00.000Z', {issue: 'GRE-1'}), notice(3, '2026-10-30T09:00:00.000Z', {issue: 'GRE-3'})])
        expect(rows.map(r => [r.issue, r.notices.map(n => n.id), r.waiting])).toEqual([['GRE-1', [2, 1], true], ['GRE-3', [3], true]])
    })
})
