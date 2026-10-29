import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {foldRepeats, repeatKey} from '../server/utils/signals'

// How a feed's signals reach its stream (`streamFeed`, signal-feed.ts): the catch-up first (what it missed and scheduled
// work nobody heard, a schedule's repeats folded and counted as heard), then each live one, in order, never one twice;
// the context the session was started with goes once; a schedule's message again before the session has finished a
// turn counts as heard rather than piling up; and a failed catch-up still sends what it missed (ORR-585). The feed is
// stood in for, as are the store and the session utils (Nitro auto-imports).
type Told = {id: number, context?: string}
let delivered: [number, string][]
let worked: [string, string][]
let carried: string[]
let idle: number | undefined
let unheard: Signal[] | Error
let context: string | undefined

const signal = (id: number, more: Partial<Signal> = {}): Signal =>
    ({id, project: 'greenhouse', kind: 'focus', delivered_to: [], instructions: [], created_by: 'ada', protected: true, created_at: '', ...more})
const message = (id: number, more: Partial<Signal> = {}) => signal(id, {kind: 'message', schedule: 4, note: 'Idle? Check the issues.', ...more})

beforeEach(() => {
    delivered = []
    worked = []
    carried = []
    idle = undefined
    unheard = []
    context = undefined
    vi.stubGlobal('useStore', () => ({
        unheardScheduled: async () => {
            if (unheard instanceof Error) throw unheard
            return unheard
        },
        delivered: async (_project: string, id: number, who: string) => void delivered.push([id, who]),
        carryUnanswered: async (_project: string, session: string) => void carried.push(session),
        workedBy: async (_project: string, issue: string, session: string) => void worked.push([issue, session]),
    }))
    vi.stubGlobal('sessionNow', () => context ? {started: {context}} : undefined)
    vi.stubGlobal('contextBlock', (given: string) => `<context>${given}</context>`)
    vi.stubGlobal('repeatKey', repeatKey)
    vi.stubGlobal('foldRepeats', foldRepeats)
    vi.stubGlobal('startRun', () => {})
    vi.stubGlobal('noteContext', () => {})
    vi.stubGlobal('idleAt', () => idle)
    vi.stubGlobal('sessionName', (id?: string) => id === 's-1' ? 'Frøya' : undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.resetModules()
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** A feed for session s-1 that wants every signal and takes all but those `refuse` names, with what it missed. */
function feedOf(missed: Signal[], refuse: number[] = []) {
    let live: ((s: Signal) => void) | null = null
    let idleSend: (s: Signal) => unknown = () => {}
    let queue: Promise<unknown> = Promise.resolve()
    return {
        project: 'greenhouse', attended: {id: 's-1'}, heard: true, missed,
        told: async (s: Signal) => ({id: s.id}),
        ours: () => true,
        wanted: (s: Signal) => s.project === 'greenhouse',
        mine: (s: Signal) => !refuse.includes(s.id),
        goLive(deliver: (s: Signal) => void, already: Set<number>) {
            live = deliver
            void already
        },
        inOrder(work: () => Promise<unknown>) {
            queue = queue.then(work)
        },
        get live() {
            return !!live
        },
        onIdle(send: (s: Signal) => unknown) {
            idleSend = send
        },
        /** A signal sent live, once the feed has gone live. */
        send: (s: Signal) => live!(s),
        sendIdle: (s: Signal) => idleSend(s),
        settled: () => queue,
    }
}

async function stream(feed: ReturnType<typeof feedOf>) {
    const {streamFeed} = await import('../server/utils/signal-feed')
    const said: Told[] = []
    await streamFeed((_s, told) => said.push(told as Told), feed as never)
    return said
}

describe("a feed's stream", () => {
    it('catches up on what it missed and unheard scheduled work, once each, folding a schedule\'s repeats as heard', async () => {
        unheard = [signal(2), message(3), message(5)]
        const feed = feedOf([signal(1), signal(2), message(4)], [1])
        const said = await stream(feed)
        await feed.settled()
        // 1 isn't the session's to take, 2 is in both, and 3 and 4 are older copies of 5.
        expect(said.map(t => t.id)).toEqual([2, 5])
        expect(delivered).toEqual([[4, 'Frøya'], [3, 'Frøya']])
        expect(carried).toEqual(['s-1'])
    })

    it('sends live signals it wants and takes, never one twice, in the order they came', async () => {
        const feed = feedOf([signal(1)], [3])
        const said = await stream(feed)
        for (const s of [signal(1), signal(2), signal(3), signal(4, {project: 'pantry'}), signal(2), signal(5)]) feed.send(s)
        await feed.settled()
        expect(said.map(t => t.id)).toEqual([1, 2, 5])
    })

    it('adds the context the session was started with to the first signal only', async () => {
        context = 'Work through Todo'
        const feed = feedOf([signal(1)])
        const said = await stream(feed)
        feed.send(signal(2))
        await feed.settled()
        expect(said).toEqual([{id: 1, context: '<context>Work through Todo</context>'}, {id: 2}])
    })

    it("counts a schedule's message again as heard while the session hasn't finished a turn since the last went", async () => {
        const feed = feedOf([])
        const said = await stream(feed)
        feed.send(message(1))
        // Its hooks said it went idle before that copy: the next is still unread.
        idle = Date.now() - 60_000
        feed.send(message(2))
        // It finished a turn since: the next goes.
        idle = Date.now() + 1
        feed.send(message(3))
        await feed.settled()
        expect(said.map(t => t.id)).toEqual([1, 3])
        await vi.waitFor(() => expect(delivered).toEqual([[2, 'Frøya']]))
    })

    it('sends every copy to a session whose hooks never said it went idle', async () => {
        const feed = feedOf([])
        const said = await stream(feed)
        feed.send(message(1))
        feed.send(message(2))
        await feed.settled()
        expect(said.map(t => t.id)).toEqual([1, 2])
    })

    it("makes the issue of the owner's comment it hands the session that session's, but not one aimed at a session", async () => {
        const feed = feedOf([])
        await stream(feed)
        feed.send(signal(1, {kind: 'comment', issue: 'GRE-3'}))
        feed.send(signal(2, {kind: 'comment', issue: 'GRE-4', target: 's-2'}))
        await feed.settled()
        await vi.waitFor(() => expect(worked).toEqual([['GRE-3', 's-1']]))
    })

    it('takes up waiting work as the session goes idle, through the same checks', async () => {
        const feed = feedOf([], [2])
        const said = await stream(feed)
        feed.sendIdle(signal(1))
        feed.sendIdle(signal(2))
        await feed.settled()
        expect(said.map(t => t.id)).toEqual([1])
    })

    it('still sends what it missed, then goes live, when the catch-up fails', async () => {
        unheard = new Error('the database went away')
        const feed = feedOf([signal(1), signal(2)], [2])
        const said = await stream(feed)
        expect(feed.live).toBe(true)
        feed.send(signal(3))
        await feed.settled()
        expect(said.map(t => t.id)).toEqual([1, 3])
        expect(carried).toEqual([])
    })
})
