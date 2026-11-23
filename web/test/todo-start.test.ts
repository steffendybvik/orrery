import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// A session started for each Todo issue nobody is free to take (ORR-1399), with Nitro's auto-imports, the launches
// and the pick list stubbed.
type Listed = {id: string, project: string, state: string, listening: boolean, also?: string[], started?: {chat?: boolean, untrusted?: boolean, launch?: string}}
let sessions: Listed[]
let todo: {id: string, priority?: string}[]
let starts: {limit: number, on_signal?: boolean} | undefined
let engaged: string[]
let onItsWay: string[]
let focuses: Record<string, {target?: string, delivered_to: string[], created_at: string}[]>
let pending: number
let room: number
let launched: {project: string, issue?: string, note?: string, actor?: {name: string, owner: boolean}}[]
let projects: string[]

vi.mock('../server/utils/launches', () => ({
    launchTarget: (launch: string) => `launch-${launch}`,
    launcherProjects: () => projects,
    pendingOn: () => pending,
    startLaunch: async (project: string, options: {issue?: string, note?: string, actor?: {name: string, owner: boolean}}) => {
        if (room < 1) throw new Error('no room')
        room--
        launched.push({project, ...options})
        return {id: `l${launched.length}`}
    },
}))
vi.mock('../server/utils/pick', () => ({
    pickable: async (_projects: string[], person?: string) => person === 'sam' ? todo.map(i => ({...i, project: 'orrery'})) : [],
}))

let start: typeof import('../server/utils/todo-start')

beforeEach(async () => {
    sessions = []
    todo = [{id: 'ORR-2', priority: 'P0'}, {id: 'ORR-3', priority: 'P2'}, {id: 'ORR-1', priority: 'P3'}]
    starts = {limit: 4}
    engaged = []
    onItsWay = []
    focuses = {}
    pending = 0
    room = 4
    launched = []
    projects = ['orrery']
    vi.stubGlobal('listSessions', () => sessions)
    vi.stubGlobal('sessionIds', (id: string) => [id])
    vi.stubGlobal('chatSession', () => false)
    vi.stubGlobal('untrustedSession', () => false)
    vi.stubGlobal('useStore', () => ({
        starts: async () => starts,
        ownerOf: async () => ({name: 'sam'}),
        engaged: async (_project: string, ids: string[]) => ids.some(id => engaged.includes(id)),
        focusOnItsWay: async (_project: string, id: string) => onItsWay.includes(id),
        focusesOn: async (_project: string, id: string) => focuses[id] ?? [],
    }))
    vi.resetModules()
    start = await import('../server/utils/todo-start')
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('starting sessions for Todo work', () => {
    it('starts one session per Todo issue, whatever its priority, most urgent first, each focused on it as the owner', async () => {
        expect(await start.startForTodo()).toBe(3)
        expect(launched.map(l => l.issue)).toEqual(['ORR-2', 'ORR-3', 'ORR-1'])
        expect(launched[0]).toMatchObject({project: 'orrery', note: start.TODO_START_NOTE, actor: {name: 'sam', owner: true}})
    })

    it('stops at the limit', async () => {
        room = 1
        expect(await start.startForTodo()).toBe(1)
        expect(launched.map(l => l.issue)).toEqual(['ORR-2'])
    })

    it('leaves the most urgent to an idle session out of work, which picks it, and to a launch on its way', async () => {
        sessions = [{id: 'a', project: 'orrery', state: 'idle', listening: true}, {id: 'b', project: 'orrery', state: 'working', listening: true}]
        pending = 1
        await start.startForTodo()
        expect(launched.map(l => l.issue)).toEqual(['ORR-1'])
    })

    it("counts an idle session with work of its own, a chat's and an untrusted one's as busy", async () => {
        sessions = [
            {id: 'a', project: 'orrery', state: 'idle', listening: true},
            {id: 'c', project: 'orrery', state: 'idle', listening: true, started: {chat: true}},
            {id: 'u', project: 'orrery', state: 'idle', listening: true, started: {untrusted: true}},
        ]
        engaged = ['a']
        await start.startForTodo()
        expect(launched.map(l => l.issue)).toEqual(['ORR-2', 'ORR-3', 'ORR-1'])
    })

    it('passes over an issue with a focus on its way', async () => {
        onItsWay = ['ORR-2']
        await start.startForTodo()
        expect(launched.map(l => l.issue)).toEqual(['ORR-3', 'ORR-1'])
    })

    it('passes over an issue handed to a session still listening, heard but not started yet', async () => {
        const now = new Date().toISOString()
        sessions = [{id: 'w', project: 'orrery', state: 'working', listening: true}, {id: 's', project: 'orrery', state: 'working', listening: true, started: {launch: 'l9'}}]
        focuses = {
            'ORR-2': [{target: 'w', delivered_to: ['w'], created_at: now}],
            'ORR-3': [{target: 'launch-l9', delivered_to: [], created_at: now}],
            // Heard by a session that's gone, or long ago: it's free again.
            'ORR-1': [{delivered_to: ['gone'], created_at: now}, {delivered_to: ['w'], created_at: new Date(Date.now() - start.RETRY_AFTER).toISOString()}],
        }
        await start.startForTodo()
        expect(launched.map(l => l.issue)).toEqual(['ORR-1'])
    })

    it("doesn't start another for the same issue within the hour, but does after", async () => {
        vi.useFakeTimers()
        await start.startForTodo()
        launched = []
        room = 4
        expect(await start.startForTodo()).toBe(0)
        vi.advanceTimersByTime(start.RETRY_AFTER)
        expect(await start.startForTodo()).toBe(3)
        vi.useRealTimers()
    })

    it('tries an issue again at the next check when there was no room for it', async () => {
        room = 0
        expect(await start.startForTodo()).toBe(0)
        room = 4
        expect(await start.startForTodo()).toBe(3)
    })

    it("starts none when orrery doesn't start sessions, or work alone doesn't (on_signal off)", async () => {
        starts = undefined
        expect(await start.startForTodo()).toBe(0)
        starts = {limit: 4, on_signal: false}
        expect(await start.startForTodo()).toBe(0)
        expect(launched).toEqual([])
    })

    it('starts none on a project no launcher serves', async () => {
        projects = []
        expect(await start.startForTodo()).toBe(0)
    })
})
