import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The clearing lives in the module, with Nitro's auto-imports stubbed: the session as it is, and the store's say on its work.
let clearing: typeof import('../server/utils/clearing')
let session: {project: string, state: string, started?: {launch: string}, idleAt?: number, listening?: boolean} | undefined
let working: string[]
let issues: {id: string, parent: string | null, kind: string, column: string, priority?: string, updated_at: string}[]
let untrusted: boolean
let chat: boolean
let waiting: boolean
let sent: unknown[]
let left: {id: string}[]
let focused: unknown[]
let carried: unknown[]

beforeEach(async () => {
    vi.useFakeTimers()
    session = {project: 'orrery', state: 'idle', started: {launch: 'l1'}, idleAt: 1, listening: true}
    working = []
    issues = []
    untrusted = false
    chat = false
    carried = []
    waiting = false
    sent = []
    left = []
    focused = []
    const events = new EventEmitter()
    events.on('launches', event => sent.push(event))
    vi.stubGlobal('projectEvents', events)
    vi.stubGlobal('sessionNow', (id: string) => id !== 'gone' && session && {...session})
    vi.stubGlobal('sessionIds', (id: string) => [id, `${id}-before`])
    vi.stubGlobal('currentId', (id: string) => id.replace(/-before$/, ''))
    vi.stubGlobal('scopeOf', async () => ({open: left}))
    vi.stubGlobal('untrustedSession', () => untrusted)
    vi.stubGlobal('chatSession', () => chat)
    vi.stubGlobal('useStore', () => ({
        workingOn: async () => working.map(id => ({id})), waiting: async () => waiting,
        focusChunk: async (...args: unknown[]) => void focused.push(args),
        listIssues: async () => issues,
        focus: async (...args: unknown[]) => void carried.push(args),
        ownerOf: async () => ({name: 'steffen'}),
    }))
    vi.resetModules()
    clearing = await import('../server/utils/clearing')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

const after = async () => {
    await vi.advanceTimersByTimeAsync(clearing.CLEAR_AFTER + 10)
}

describe('a session Orrery started, gone idle', () => {
    it('is cleared through its launcher once it has nothing in progress and nothing waiting', async () => {
        clearing.considerClear('orrery', 'w')
        await after()
        expect(sent).toEqual([{type: 'clear', project: 'orrery', id: 'l1'}])
    })

    it('is left as it is with an issue in progress, a signal waiting, or a new turn started meanwhile', async () => {
        working = ['ORR-1']
        clearing.considerClear('orrery', 'w')
        await after()
        working = []
        waiting = true
        clearing.considerClear('orrery', 'w')
        await after()
        waiting = false
        clearing.considerClear('orrery', 'w')
        session = {...session!, state: 'working'}
        await after()
        session = {...session!, state: 'idle', idleAt: 2}
        await after()
        expect(sent).toEqual([])
    })

    it("isn't cleared when it's the owner's chat, which keeps its conversation", async () => {
        session = {...session!, started: {launch: 'l1', chat: true} as {launch: string}}
        clearing.considerClear('orrery', 'w')
        await after()
        expect(sent).toEqual([])
    })

    it("isn't cleared when it's a session someone opened themselves", async () => {
        session = {project: 'orrery', state: 'idle', idleAt: 1}
        clearing.considerClear('orrery', 'w')
        await after()
        expect(sent).toEqual([])
    })
})

describe("a session's run", () => {
    const signal = (more: object) => ({id: 1, project: 'orrery', kind: 'focus', delivered_to: [], instructions: [], created_by: 'steffen', protected: true, created_at: '', ...more}) as never

    it('is the last chunk or scope focus it was handed, found by any id it has had', () => {
        clearing.startRun('w-before', signal({chunk: 'all', status: 'todo'}))
        clearing.startRun('w-before', signal({kind: 'message', note: 'hi'}))
        expect(clearing.runOf('w')).toMatchObject({chunk: 'all', status: 'todo'})
        expect(clearing.runOf('other')).toBeUndefined()
    })

    it('ends with a focus on one issue, and is let go once its session is gone', () => {
        clearing.startRun('w', signal({chunk: '3'}))
        clearing.startRun('w', signal({issue: 'ORR-98', note: clearing.CARRY_ON}))
        expect(clearing.runOf('w')).toMatchObject({chunk: '3'})
        clearing.startRun('w-before', signal({issue: 'ORR-99'}))
        expect(clearing.runOf('w')).toBeUndefined()
        clearing.startRun('gone', signal({chunk: '3'}))
        clearing.startRun('w', signal({chunk: '4'}))
        expect(clearing.runOf('gone')).toBeUndefined()
        expect(clearing.runOf('w')).toMatchObject({chunk: '4'})
    })

    it("goes on after a clear: what's left of it is sent to the session alone, as its owner sent it", async () => {
        clearing.startRun('w', signal({chunk: 'all', status: 'todo,started', release: '1.2'}))
        expect(await clearing.resumeRun('orrery', 'w')).toBe(false)
        left = [{id: 'ORR-2'}]
        expect(await clearing.resumeRun('elsewhere', 'w')).toBe(false)
        expect(await clearing.resumeRun('orrery', 'w')).toBe(true)
        expect(focused).toEqual([['orrery', 'all', {session: 'w', status: 'todo,started', release: '1.2', note: "Carry on with what's left of it after the clear."}, {name: 'steffen', owner: true}]])
        // Nothing left has changed since: it isn't sent again, so a session that won't take it isn't kept going round.
        expect(await clearing.resumeRun('orrery', 'w')).toBe(false)
        left = [{id: 'ORR-2', updated_at: 'later'}]
        expect(await clearing.resumeRun('orrery', 'w')).toBe(true)
        expect(focused).toHaveLength(2)
        // A new run starts afresh.
        clearing.startRun('w', signal({chunk: 'all', status: 'todo'}))
        expect(await clearing.resumeRun('orrery', 'w')).toBe(true)
        // One someone opened themselves isn't sent on.
        session = {project: 'orrery', state: 'idle', idleAt: 1}
        expect(await clearing.resumeRun('orrery', 'w')).toBe(false)
    })
})

describe('a session gone idle on an issue with sub-issues to do', () => {
    const sub = (id: string, more: object = {}) => ({id, parent: 'ORR-1', kind: 'todo', column: 'todo', updated_at: 't1', ...more})
    const owners = (id: string) => ['orrery', id, {session: 'w', note: clearing.CARRY_ON}, {name: 'steffen', owner: true}]

    beforeEach(() => {
        working = ['ORR-1']
        issues = [{id: 'ORR-1', parent: null, kind: 'started', column: 'in-progress', updated_at: 't0'}, sub('ORR-2', {priority: 'P2'}), sub('ORR-3', {priority: 'P1'}), sub('ORR-4', {kind: 'done', column: 'done', priority: 'P0'}), sub('ORR-5', {parent: 'ORR-9', priority: 'P0'})]
    })

    it('is sent on to the most urgent of them, alone and as the owner, once it stays idle', async () => {
        clearing.carryOn('orrery', 'w')
        expect(carried).toEqual([])
        await after()
        expect(carried).toEqual([owners('ORR-3')])
    })

    it("is sent on whether or not Orrery started it, but not when it isn't listening", async () => {
        session = {project: 'orrery', state: 'idle', idleAt: 1, listening: true}
        clearing.carryOn('orrery', 'w')
        await after()
        expect(carried).toEqual([owners('ORR-3')])
        session = {...session, idleAt: 2, listening: false}
        clearing.carryOn('orrery', 'w')
        await after()
        expect(carried).toHaveLength(1)
    })

    it("is left be with a signal waiting, a new turn started, nothing in progress, no sub-issue to do, an untrusted schedule's run or a chat", async () => {
        waiting = true
        clearing.carryOn('orrery', 'w')
        await after()
        waiting = false
        clearing.carryOn('orrery', 'w')
        session = {...session!, state: 'working'}
        await after()
        session = {...session!, state: 'idle', idleAt: 2}
        working = []
        clearing.carryOn('orrery', 'w')
        await after()
        working = ['ORR-1']
        issues = issues.filter(i => i.id === 'ORR-1' || i.id === 'ORR-4')
        clearing.carryOn('orrery', 'w')
        await after()
        issues.push(sub('ORR-6'))
        untrusted = true
        clearing.carryOn('orrery', 'w')
        await after()
        untrusted = false
        chat = true
        clearing.carryOn('orrery', 'w')
        await after()
        expect(carried).toEqual([])
    })

    it("isn't sent the same sub-issue again until it changes", async () => {
        clearing.carryOn('orrery', 'w')
        await after()
        clearing.carryOn('orrery', 'w')
        await after()
        expect(carried).toHaveLength(1)
        issues = issues.map(i => i.id === 'ORR-3' ? {...i, updated_at: 't2'} : i)
        clearing.carryOn('orrery', 'w')
        await after()
        expect(carried).toEqual([owners('ORR-3'), owners('ORR-3')])
    })
})
