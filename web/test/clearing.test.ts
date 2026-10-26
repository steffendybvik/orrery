import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The clearing lives in the module, with Nitro's auto-imports stubbed: the session as it is, and the store's say on its work.
let clearing: typeof import('../server/utils/clearing')
let session: {project: string, state: string, started?: {launch: string}, idleAt?: number} | undefined
let working: string[]
let waiting: boolean
let sent: unknown[]

beforeEach(async () => {
    vi.useFakeTimers()
    session = {project: 'orrery', state: 'idle', started: {launch: 'l1'}, idleAt: 1}
    working = []
    waiting = false
    sent = []
    const events = new EventEmitter()
    events.on('launches', event => sent.push(event))
    vi.stubGlobal('projectEvents', events)
    vi.stubGlobal('sessionNow', () => session && {...session})
    vi.stubGlobal('sessionIds', (id: string) => [id, `${id}-before`])
    vi.stubGlobal('useStore', () => ({workingOn: async () => working, waiting: async () => waiting}))
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
    it('is the last chunk or scope focus it was handed, found by any id it has had', () => {
        const signal = (more: object) => ({id: 1, project: 'orrery', kind: 'focus', delivered_to: [], instructions: [], created_by: 'steffen', protected: true, created_at: '', ...more}) as never
        clearing.startRun('w-before', signal({chunk: 'all', status: 'todo'}))
        clearing.startRun('w-before', signal({issue: 'ORR-1'}))
        expect(clearing.runOf('w')).toMatchObject({chunk: 'all', status: 'todo'})
        expect(clearing.runOf('other')).toBeUndefined()
    })
})
