import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The clearing lives in the module, with Nitro's auto-imports stubbed: the session as it is, and the store's say on its work.
let clearing: typeof import('../server/utils/clearing')
let session: {project: string, state: string, started?: {launch: string}, idleAt?: number} | undefined
let working: string[]
let waiting: boolean
let sent: unknown[]
let left: {id: string}[]
let focused: unknown[]

beforeEach(async () => {
    vi.useFakeTimers()
    session = {project: 'orrery', state: 'idle', started: {launch: 'l1'}, idleAt: 1}
    working = []
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
    vi.stubGlobal('useStore', () => ({
        workingOn: async () => working, waiting: async () => waiting,
        focusChunk: async (...args: unknown[]) => void focused.push(args),
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
        // One someone opened themselves isn't sent on.
        session = {project: 'orrery', state: 'idle', idleAt: 1}
        expect(await clearing.resumeRun('orrery', 'w')).toBe(false)
    })
})
