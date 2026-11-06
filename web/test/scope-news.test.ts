import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// A session hearing that what its issue sits under changed (ORR-984), with Nitro's auto-imports stubbed: the board,
// who works what, and the messages sent.
let news: typeof import('../server/utils/scope-news')
let board: {id: string, kind: string, parent?: string, milestone?: string | null, epic?: number}[]
let workers: Record<string, string>
let persons: Record<string, string>
let sent: {session: string, text: string}[]

const owner = {name: 'steffen', owner: true}
const event = (type: string, subject: string, more: Record<string, unknown> = {}) => ({event: {type, project: 'orrery', subject, by: owner, ...more}})

beforeEach(async () => {
    vi.useFakeTimers()
    board = [
        {id: 'ORR-1', kind: 'started', milestone: '7', epic: 3},
        {id: 'ORR-2', kind: 'started', parent: 'ORR-1', milestone: '7'},
        {id: 'ORR-3', kind: 'todo', milestone: '7', epic: 3},
        {id: 'ORR-4', kind: 'started', milestone: '8'},
    ]
    workers = {'ORR-1': 'a', 'ORR-2': 'b', 'ORR-3': 'c', 'ORR-4': 'a'}
    persons = {}
    sent = []
    vi.stubGlobal('useStore', () => ({
        listIssues: async () => board,
        listMilestones: async () => [{id: '7', title: 'Launch'}, {id: '8', title: 'Later'}],
        epics: async () => [{id: 3, title: 'Checkout'}],
        workerOf: async (_project: string, id: string) => workers[id] ?? null,
        sessionPerson: (session: string) => persons[session],
        ownerOf: async () => ({name: 'steffen'}),
        messageSession: async (_project: string, session: string, text: string) => void sent.push({session, text}),
    }))
    vi.resetModules()
    news = await import('../server/utils/scope-news')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

async function hear(...events: Parameters<typeof news.heardScope>[0][]) {
    for (const each of events) news.heardScope(each)
    await vi.advanceTimersByTimeAsync(news.SCOPE_AFTER)
}

describe('telling sessions what their issues sit under (ORR-984)', () => {
    it('tells the session on a moved issue and on its sub-issues, once each for a burst', async () => {
        await hear(event('issue.milestone', 'ORR-1', {from: '7', to: '8'}), event('issue.epic', 'ORR-4', {to: '3'}))
        expect(sent.map(s => s.session).sort()).toEqual(['a', 'b'])
        const a = sent.find(s => s.session === 'a')!.text
        expect(a).toContain('ORR-1 moved from milestone 7 "Launch" to milestone 8 "Later".')
        expect(a).toContain('ORR-4 moved from no epic to epic 3 "Checkout".')
        expect(sent.find(s => s.session === 'b')!.text).toContain('ORR-2, under ORR-1, moved from milestone 7')
    })

    it('tells the sessions on started issues in a milestone or epic that changed, and none on one not started', async () => {
        await hear(event('milestone.changed', '7'))
        expect(sent.map(s => s.session).sort()).toEqual(['a', 'b'])
        sent = []
        await hear(event('epic.changed', '3'))
        expect(sent.map(s => s.session).sort()).toEqual(['a', 'b'])
        expect(sent.find(s => s.session === 'b')!.text).toContain('epic 3 "Checkout", which ORR-2 is under, changed')
    })

    it('says a deleted one is gone', async () => {
        await hear(event('issue.milestone', 'ORR-4', {from: '9'}))
        expect(sent[0]!.text).toContain('ORR-4 moved from milestone 9 (deleted) to no milestone.')
    })

    it("tells nobody of an agent's, orrery's, a schedule run's or an untrusted session's change", async () => {
        await hear(
            event('issue.milestone', 'ORR-1', {by: {name: 'claude', owner: false}}),
            event('issue.milestone', 'ORR-1', {by: {name: 'orrery', owner: false}}),
            {...event('issue.milestone', 'ORR-1'), cause: {schedule: 1}},
            event('issue.milestone', 'ORR-1', {untrusted: true}),
        )
        expect(sent).toEqual([])
    })

    it("tells a member's change only to their own sessions (ORR-658)", async () => {
        persons = {a: 'hati', b: 'steffen'}
        await hear(event('milestone.changed', '7', {by: {name: 'hati', owner: false, person: 'hati'}}))
        expect(sent.map(s => s.session)).toEqual(['a'])
    })
})
