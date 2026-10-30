import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal} from '#shared/roadmap'
import type {Listener} from '../server/utils/signal-feed'

// Opening a project's feed for a session (`openFeed`, signal-feed.ts): who counts as listening (not a session that can't
// hear, an untrusted run's or a chat), what it missed and which signals are its own, live signals held until the
// catch-up has gone, waiting work as it goes idle, and closing it, once (ORR-585). The store, the sessions and the pool
// are Nitro auto-imports, stood in for here.
let events: EventEmitter
let log: string[]
let missed: Signal[] | Error
let waiting: Signal[]
let taken: Set<number>

const signal = (id: number, more: Partial<Signal> = {}): Signal =>
    ({id, project: 'greenhouse', kind: 'focus', delivered_to: [], instructions: [], created_by: 'ada', protected: true, created_at: '', ...more})
const who = (more: Partial<Listener> = {}): Listener => ({session: 's-1', heard: true, stops: false, untrusted: false, chat: false, ...more})

beforeEach(() => {
    events = new EventEmitter()
    log = []
    missed = []
    waiting = []
    taken = new Set()
    vi.stubGlobal('projectEvents', events)
    vi.stubGlobal('useStore', () => ({
        project: async (id: string) => {
            if (id !== 'greenhouse') throw Object.assign(new Error(`No project ${id}`), {statusCode: 404})
        },
        listSignals: async (_project: string, from: number) => {
            if (missed instanceof Error) throw missed
            log.push(`listSignals ${from}`)
            return missed
        },
        pooledWaiting: async () => waiting,
    }))
    vi.stubGlobal('attend', (project: string, id: string) => {
        log.push(`attend ${project} ${id}`)
        return {id, done: () => log.push(`left ${id}`)}
    })
    vi.stubGlobal('listen', (project: string) => {
        log.push(`listen ${project}`)
        return () => log.push(`unlisten ${project}`)
    })
    vi.stubGlobal('currentId', (id: string) => id === 's-old' ? 's-1' : id)
    vi.stubGlobal('aimedAt', (s: Signal, session?: string) => !s.target || s.target === session)
    vi.stubGlobal('pooled', (s: Signal) => !s.target)
    vi.stubGlobal('take', (s: Signal) => !taken.has(s.id) && !!taken.add(s.id))
    vi.stubGlobal('handBack', (project: string, session: string) => log.push(`handBack ${project} ${session}`))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.resetModules()
    vi.doMock('../server/utils/signal-payload', () => ({signalPayload: async (_store: unknown, _project: string, s: Signal, at: {api: string, me?: string}) => ({id: s.id, ...at})}))
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.doUnmock('../server/utils/signal-payload')
})

async function open(listener = who(), from?: number) {
    const {openFeed} = await import('../server/utils/signal-feed')
    return openFeed('greenhouse', listener, from, 'http://localhost:9000')
}

describe("a project's feed", () => {
    it('hears a member\'s signal only on that member\'s session (ORR-658)', async () => {
        const hatis = signal(1, {protected: false, person: 'hati'})
        const feed = await open(who({person: 'hati'}))
        expect(feed.wanted(hatis)).toBe(true)
        const theirs = await open(who({session: 's-2', person: 'manni'}))
        expect(theirs.wanted(hatis)).toBe(false)
        expect(theirs.wanted(signal(2))).toBe(true)
        expect(theirs.wanted(signal(3, {protected: false}))).toBe(false)
        missed = [hatis, signal(2)]
        expect((await open(who({session: 's-3', person: 'manni'}), 0)).missed.map(s => s.id)).toEqual([2])
    })

    it('counts a session that hears as listening, and lets go of it once on close', async () => {
        const feed = await open()
        expect(log).toEqual(['attend greenhouse s-1', 'listen greenhouse'])
        feed.close()
        feed.close()
        expect(log.slice(2)).toEqual(['handBack greenhouse s-1', 'unlisten greenhouse', 'left s-1'])
        expect(events.listenerCount('signal')).toBe(0)
        expect(events.listenerCount('session-idle')).toBe(0)
    })

    it("doesn't count as listening a session that can't hear, an untrusted run's or a chat", async () => {
        for (const listener of [who({heard: false}), who({untrusted: true}), who({chat: true}), who({started: {launch: 'l', untrusted: true} as never}), who({started: {launch: 'l', chat: true} as never})]) {
            log = []
            ;(await open(listener)).close()
            expect(log).not.toContain('listen greenhouse')
        }
    })

    it('attends nobody for a stream with no session, and refuses a project that isn\'t there', async () => {
        const feed = await open(who({session: undefined}))
        expect(log).toEqual(['listen greenhouse'])
        expect(feed.attended).toBeNull()
        const {openFeed} = await import('../server/utils/signal-feed')
        await expect(openFeed('nowhere', who(), undefined, 'http://localhost:9000')).rejects.toMatchObject({statusCode: 404})
    })

    it("catches up after `from` on the project's own protected signals for it, and on none without `from`", async () => {
        missed = [signal(1), signal(2, {project: 'pantry'}), signal(3, {protected: false}), signal(4, {target: 's-2'}), signal(5, {target: 's-1'})]
        expect((await open(who(), 0)).missed.map(s => s.id)).toEqual([1, 5])
        log = []
        expect((await open()).missed).toEqual([])
        expect(log).not.toContain('listSignals 0')
    })

    it('lets go of everything when the catch-up read fails, and says why', async () => {
        missed = new Error('the database went away')
        await expect(open(who(), 0)).rejects.toThrow('the database went away')
        expect(log).toEqual(['attend greenhouse s-1', 'listen greenhouse', 'unlisten greenhouse', 'left s-1'])
        expect(events.listenerCount('signal')).toBe(0)
    })

    it('wants only new, protected signals on the project for it, and takes a pooled one only when it can hear and nobody has', async () => {
        const feed = await open()
        expect([signal(1), signal(2, {protected: false}), signal(3, {delivered_to: ['Ada']}), signal(4, {project: 'pantry'}), signal(5, {target: 's-2'})].map(feed.wanted))
            .toEqual([true, false, false, false, false])
        expect([feed.mine(signal(6)), feed.mine(signal(6)), feed.mine(signal(7, {target: 's-1'}))]).toEqual([true, false, true])
        const deaf = await open(who({heard: false}))
        expect(deaf.mine(signal(8))).toBe(false)
        expect(deaf.mine(signal(9, {target: 's-1'}))).toBe(true)
    })

    it('holds live signals until it goes live, then sends them, leaving out those the catch-up sent', async () => {
        const feed = await open()
        events.emit('signal', signal(1))
        events.emit('signal', signal(2))
        expect(feed.live).toBe(false)
        const sent: number[] = []
        feed.goLive(s => sent.push(s.id), new Set([1]))
        events.emit('signal', signal(3))
        expect(feed.live).toBe(true)
        expect(sent).toEqual([2, 3])
    })

    it('hands it waiting work when it goes idle, by any id it has had, and not when another session does', async () => {
        waiting = [signal(1), signal(2)]
        const feed = await open()
        const sent: number[] = []
        feed.onIdle(s => sent.push(s.id))
        events.emit('session-idle', 's-2')
        events.emit('session-idle', 's-old')
        await vi.waitFor(() => expect(sent).toEqual([1, 2]))
        const deaf = await open(who({heard: false, session: 's-3'}))
        const none: number[] = []
        deaf.onIdle(s => none.push(s.id))
        events.emit('session-idle', 's-3')
        await new Promise(resolve => setTimeout(resolve))
        expect(none).toEqual([])
    })

    it('tells a signal with the addresses for its project and who it is, and works through signals one after another', async () => {
        const feed = await open(who({session: 's-old'}))
        expect(await feed.told(signal(1))).toEqual({id: 1, api: 'http://localhost:9000/api/projects/greenhouse', me: 's-1'})
        const order: string[] = []
        feed.inOrder(async () => {
            await new Promise(resolve => setTimeout(resolve, 10))
            order.push('slow')
        })
        feed.inOrder(async () => {
            throw new Error('one failed')
        })
        feed.inOrder(async () => void order.push('after'))
        await vi.waitFor(() => expect(order).toEqual(['slow', 'after']))
    })
})
