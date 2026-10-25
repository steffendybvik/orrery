import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The sessions live in the module, so each test gets a fresh one; `projectEvents` is a Nitro auto-import.
let sessions: typeof import('../server/utils/sessions')
let changed: string[]

beforeEach(async () => {
    changed = []
    const events = new EventEmitter()
    events.on('sessions', project => changed.push(project))
    vi.stubGlobal('projectEvents', events)
    vi.resetModules()
    sessions = await import('../server/utils/sessions')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('a session', () => {
    it('is named after its project, the lowest number free', () => {
        expect(sessions.report({id: 'a', project: 'larder', event: 'SessionStart'})?.name).toBe('larder 1')
        expect(sessions.report({id: 'b', project: 'larder', event: 'SessionStart'})?.name).toBe('larder 2')
        sessions.report({id: 'a', project: 'larder', event: 'SessionEnd'})
        expect(sessions.report({id: 'c', project: 'larder', event: 'SessionStart'})?.name).toBe('larder 1')
        expect(sessions.report({id: 'd', project: 'larder', name: 'pantry', event: 'SessionStart'})?.name).toBe('pantry')
        expect(changed.every(p => p === 'larder')).toBe(true)
    })

    it('follows its hooks: working, idle, and waiting when asked for a permission', () => {
        const state = (event: string, message?: string) => sessions.report({id: 'a', project: 'larder', event, message})?.state
        expect(state('SessionStart')).toBe('idle')
        expect(state('UserPromptSubmit')).toBe('working')
        expect(state('Notification', 'Claude needs your permission to use Bash')).toBe('waiting')
        expect(state('Notification', 'Claude is waiting for your input')).toBe('idle')
        expect(state('Stop')).toBe('idle')
        expect(state('starting')).toBe('starting')
        expect(state('SessionEnd')).toBeUndefined()
        expect(sessions.listSessions('larder')).toEqual([])
    })

    it('keeps the time its state began until the state changes', () => {
        vi.useFakeTimers({now: new Date('2026-10-25T10:00:00Z')})
        const first = sessions.report({id: 'a', project: 'larder', event: 'UserPromptSubmit'})!
        vi.setSystemTime(new Date('2026-10-25T10:01:00Z'))
        expect(sessions.report({id: 'a', project: 'larder', event: 'PreToolUse'})!.since).toBe(first.since)
        expect(sessions.report({id: 'a', project: 'larder', event: 'Stop'})!.since).toBe('2026-10-25T10:01:00.000Z')
    })

    it('first heard of by its pid takes its id when a hook brings it, and keeps no pid in public', () => {
        expect(sessions.report({pid: 42, project: 'larder', event: 'SessionStart'})?.id).toBe('pid-42')
        const now = sessions.report({id: 'abc', pid: 42, project: 'larder', cwd: '/repo', event: 'UserPromptSubmit'})!
        expect(now).toMatchObject({id: 'abc', name: 'larder 1', cwd: '/repo', state: 'working'})
        expect(now).not.toHaveProperty('pid')
        expect(sessions.listSessions().map(s => s.id)).toEqual(['abc'])
        expect(sessions.sessionName('abc')).toBe('larder 1')
        expect(sessions.sessionName(undefined)).toBeUndefined()
    })

    it('listens while its channel is connected', () => {
        const {id, done} = sessions.attend('larder', 'a', undefined, 'pantry')
        expect(sessions.listSessions('larder')).toMatchObject([{id, name: 'pantry', listening: true}])
        done()
        expect(sessions.listSessions('larder')[0]!.listening).toBe(false)
        // A session started without the channel flag connects but wouldn't hear.
        expect(sessions.attend('larder', 'b', undefined, undefined, false)).toMatchObject({id: 'b'})
        expect(sessions.listSessions('larder').find(s => s.id === 'b')).toMatchObject({name: 'larder 1', listening: false})
    })

    it('started by Orrery says which launch, and counts as one it started while its channel is there', () => {
        const launch = (id: string) => ({launch: id, tmux: `orrery-larder-${id}`, stopsAt: '2026-10-25T11:00:00.000Z'})
        const a = sessions.attend('larder', 'a', undefined, undefined, true, launch('l1'))
        sessions.attend('larder', 'b', undefined, undefined)
        sessions.attend('mesa', 'c', undefined, undefined, true, launch('l3'))
        expect(sessions.listSessions('larder').map(s => s.started?.launch)).toEqual(['l1', undefined])
        expect([sessions.startedSessions('larder'), sessions.startedSessions()]).toEqual([1, 2])
        // Its channel gone (it crashed, or was killed by hand), it no longer holds a place.
        a.done()
        expect(sessions.startedSessions('larder')).toBe(0)
        expect(sessions.sessionOfLaunch('larder', 'l1')?.id).toBe('a')
        expect(sessions.extendLaunch('larder', 'l1', '2026-10-25T11:30:00.000Z')?.started?.stopsAt).toBe('2026-10-25T11:30:00.000Z')
        // Its launcher saying it ended drops it, by its launch.
        sessions.launchEnded('larder', 'l1')
        sessions.launchEnded('larder', 'l3')
        expect(sessions.listSessions().map(s => s.id)).toEqual(['b', 'c'])
        expect(sessions.extendLaunch('larder', 'l1', '2026-10-25T12:00:00.000Z')).toBeUndefined()
    })

    it('is forgotten after six quiet hours, unless it is listening', () => {
        vi.useFakeTimers({now: new Date('2026-10-25T10:00:00Z')})
        sessions.report({id: 'quiet', project: 'larder', event: 'Stop'})
        sessions.attend('larder', 'listening', undefined, undefined)
        sessions.report({id: 'other', project: 'mesa', event: 'Stop'})
        expect(sessions.listSessions('larder').map(s => s.id)).toEqual(['quiet', 'listening'])
        vi.setSystemTime(new Date('2026-10-25T16:00:01Z'))
        expect(sessions.listSessions().map(s => s.id)).toEqual(['listening'])
    })
})

describe('listeners', () => {
    it('are counted per project, each once however often it says it is done', async () => {
        const {listen, listening, projectEvents} = await import('../server/utils/events')
        const heard: string[] = []
        projectEvents.on('listeners', project => heard.push(project))
        const one = listen('larder')
        const two = listen('larder')
        expect([listening('larder'), listening('mesa')]).toEqual([2, 0])
        one()
        one()
        expect(listening('larder')).toBe(1)
        two()
        expect(listening('larder')).toBe(0)
        expect(heard).toEqual(['larder', 'larder', 'larder', 'larder'])
    })
})

describe('the issues a session writes to', () => {
    it('are the ones its curls send a body or a PATCH, POST or PUT to', () => {
        const writes = (command: string) => sessions.issueWrites(command, 'larder').map(w => `${w.project}/${w.issue}`)
        expect(writes(`curl -s -X PATCH http://localhost:9000/api/projects/larder/issues/LAR-12 -d '{"status":"done"}'`)).toEqual(['larder/LAR-12'])
        expect(writes(`curl -s -X POST $ISSUES/LAR-3/comments -H "$H" --data @reply.json && curl -s $ISSUES/LAR-4`)).toEqual(['larder/LAR-3'])
        expect(writes(`curl -X PUT http://x/api/projects/pantry/issues/PAN-1 -d '{}'`)).toEqual(['pantry/PAN-1'])
        expect(writes('curl -s http://localhost:9000/api/projects/larder/issues/LAR-12')).toEqual([])
        expect(writes('git commit -m "fix LAR-12" -d')).toEqual([])
        expect(writes(`curl -X DELETE $ISSUES/LAR-9`)).toEqual([])
    })

    it("note the session as the issue's worker, from its hook", async () => {
        const worked: string[] = []
        vi.stubGlobal('useStore', () => ({workedBy: async (project: string, issue: string, session: string) => worked.push(`${project}/${issue}:${session}`)}))
        sessions.report({id: 'a', project: 'larder', event: 'PreToolUse', command: `curl -X PATCH $ISSUES/LAR-7 -d '{"status":"in-progress"}'`})
        sessions.report({id: 'b', project: 'larder', event: 'PreToolUse', command: 'ls'})
        await Promise.resolve()
        expect(worked).toEqual(['larder/LAR-7:a'])
    })
})

describe('stopping a session', () => {
    beforeEach(() => {
        vi.stubGlobal('notFound', (message: string) => Object.assign(new Error(message), {statusCode: 404}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
    })

    it("asks its channel to end it, and drops it once the channel's gone", () => {
        const asked: unknown[] = []
        projectEvents.on('session-stop', event => asked.push(event))
        expect(() => sessions.stopSession('larder', 'a')).toThrow('No session a in larder')
        sessions.report({id: 'a', project: 'larder', event: 'SessionStart'})
        expect(() => sessions.stopSession('larder', 'a')).toThrow("has no Orrery channel running")
        expect(sessions.listSessions('larder')[0]!.reachable).toBe(false)
        // A channel without the flag can't hear signals, but can still be stopped.
        const first = sessions.attend('larder', 'a', undefined, undefined, false)
        const second = sessions.attend('larder', 'a', undefined, undefined, false)
        expect(sessions.listSessions('larder')[0]!.reachable).toBe(true)
        expect(() => sessions.stopSession('mesa', 'a')).toThrow('No session a in mesa')
        expect(sessions.stopSession('larder', 'a').name).toBe('larder 1')
        expect(asked).toEqual([{project: 'larder', id: 'a'}])
        first.done()
        expect(sessions.listSessions('larder')).toHaveLength(1)
        second.done()
        expect(sessions.listSessions('larder')).toEqual([])
    })

    it("goes through the launcher for one Orrery started", () => {
        vi.stubGlobal('stopLaunch', (project: string, launch: string) => ({project, launch}))
        sessions.attend('larder', 'b', undefined, undefined, true, {launch: 'abc', tmux: 'orrery-larder-abc', stopsAt: '2999-01-01T00:00:00.000Z'})
        expect(sessions.stopSession('larder', 'b')).toEqual({project: 'larder', launch: 'abc'})
    })
})
