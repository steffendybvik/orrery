import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal, Starts} from '#shared/roadmap'

// The launches live in the module, so each test gets a fresh one, with Nitro's auto-imports stubbed.
let launches: typeof import('../server/utils/launches')
let sent: {type: string, project?: string, id?: string, after?: number, minutes?: number, stops_at?: string}[]
let listeners: number
let started: {larder: number, all: number}
let starts: Starts | undefined
let session: {started?: {launch: string, tmux: string, stops_at: string}} | undefined
let adopted: string[]
let focused: {issue: string, session: string}[]
let scoped: {chunk: string, body: Record<string, unknown>}[]

beforeEach(async () => {
    sent = []
    listeners = 0
    started = {larder: 0, all: 0}
    starts = {limit: 2, minutes: 30}
    session = undefined
    adopted = []
    const events = new EventEmitter()
    events.on('launches', event => sent.push(event.type === 'launch' ? {type: 'launch', after: event.launch.after, minutes: event.launch.minutes} : event))
    vi.stubGlobal('projectEvents', events)
    const {counter} = await import('../server/utils/events')
    vi.stubGlobal('counter', counter)
    vi.stubGlobal('listening', () => listeners)
    vi.stubGlobal('startedSessions', (project?: string) => project ? started.larder : started.all)
    vi.stubGlobal('sessionOfLaunch', () => session)
    vi.stubGlobal('adoptLaunch', (_project: string, started: {launch: string}) => adopted.push(started.launch))
    vi.stubGlobal('extendLaunch', (_project: string, _id: string, stops_at: string) => ({...session, started: {...session!.started!, stops_at}}))
    vi.stubGlobal('notFound', (message: string) => Object.assign(new Error(message), {statusCode: 404}))
    vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
    // A tick for reading the project, as the database gives, so signals can overlap.
    focused = []
    scoped = []
    vi.stubGlobal('useStore', () => ({
        starts: () => new Promise(resolve => setTimeout(() => resolve(starts), 0)),
        lastSignal: async () => 41,
        focus: async (_project: string, issue: string, body: {session: string}) => {
            if (issue === 'LAR-404') throw Object.assign(new Error('No issue LAR-404'), {statusCode: 404})
            focused.push({issue, session: body.session})
            return {id: 42}
        },
        focusChunk: async (_project: string, chunk: string, body: Record<string, unknown>) => {
            scoped.push({chunk, body})
            return {id: 43}
        },
    }))
    vi.resetModules()
    launches = await import('../server/utils/launches')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

const signal = (id: number, more: Partial<Signal> = {}) => ({id, project: 'larder', kind: 'focus', protected: true, delivered_to: [], ...more}) as Signal

describe('starting a session', () => {
    it("happens for the owner's signal that nobody is listening for, once a launcher is there", async () => {
        expect(await launches.considerLaunch(signal(5))).toBeNull()
        const done = launches.addLauncher('larder')
        expect(await launches.considerLaunch(signal(6, {protected: false}))).toBeNull()
        listeners = 1
        expect(await launches.considerLaunch(signal(6))).toBeNull()
        listeners = 0
        const launch = await launches.considerLaunch(signal(7))
        expect(launch).toMatchObject({project: 'larder', after: 6, minutes: 30, tmux: `orrery-larder-${launch!.id}`})
        expect(sent).toEqual([{type: 'launch', after: 6, minutes: 30}])
        // The launch on its way covers what comes after it, until its session connects.
        expect(await launches.considerLaunch(signal(8))).toBeNull()
        expect(launches.launchState('larder')).toEqual({launchers: 1, started: 0, starting: 1})
        expect(launches.launched(launch!.id)).toMatchObject({launch: launch!.id, tmux: launch!.tmux})
        started = {larder: 1, all: 1}
        expect(await launches.considerLaunch(signal(9))).not.toBeNull()
        done()
        expect(launches.launchState('larder').launchers).toBe(0)
    })

    it("isn't for a signal aimed at one session, or one that's been delivered", async () => {
        launches.addLauncher('larder')
        expect(await launches.considerLaunch(signal(1, {target: 'window-a'}))).toBeNull()
        expect(await launches.considerLaunch(signal(1, {delivered_to: ['larder 1']}))).toBeNull()
        expect(sent).toEqual([])
    })

    it('starts one session for signals that come together', async () => {
        launches.addLauncher('larder')
        const both = await Promise.all([launches.considerLaunch(signal(1)), launches.considerLaunch(signal(2))])
        expect(both.filter(Boolean)).toHaveLength(1)
        expect(sent).toHaveLength(1)
    })

    it('goes to the first launcher that claims it', async () => {
        launches.addLauncher('larder')
        launches.addLauncher('larder')
        const launch = (await launches.considerLaunch(signal(1)))!
        expect([launches.claim('larder', launch.id), launches.claim('larder', launch.id), launches.claim('mesa', launch.id)]).toEqual([true, false, false])
        expect(launches.claim('larder', 'nope')).toBe(false)
    })

    it("needs the owner's opt-in, and stays within the project's limit, whatever other projects run", async () => {
        launches.addLauncher('larder')
        starts = undefined
        expect(await launches.considerLaunch(signal(1))).toBeNull()
        starts = {limit: 2, minutes: 30}
        started = {larder: 2, all: 2}
        expect(await launches.considerLaunch(signal(2))).toBeNull()
        started = {larder: 1, all: 9}
        expect(await launches.considerLaunch(signal(3))).not.toBeNull()
        // A refused launch isn't left holding the project's place.
        expect(launches.launchState('larder').starting).toBe(1)
    })

    it('lets a launch go whose session never connects', async () => {
        launches.addLauncher('larder')
        expect(await launches.considerLaunch(signal(1))).not.toBeNull()
        expect(await launches.considerLaunch(signal(2))).toBeNull()
        vi.useFakeTimers({now: Date.now() + 3 * 60 * 1000 + 1000, toFake: ['Date']})
        expect(await launches.considerLaunch(signal(3))).not.toBeNull()
    })

    it('lets a launch go at once when it ends before its session connects', async () => {
        launches.addLauncher('larder')
        const launch = (await launches.considerLaunch(signal(1)))!
        launches.launchGone(launch.id)
        expect(launches.launchState('larder').starting).toBe(0)
        expect(await launches.considerLaunch(signal(2))).not.toBeNull()
    })
})

describe('the owner starting a session by hand', () => {
    it("catches up from the latest signal, given the project's opt-in, a launcher and room under its limit", async () => {
        starts = undefined
        await expect(launches.startLaunch('larder')).rejects.toThrow("doesn't let Orrery start sessions")
        starts = {limit: 2, minutes: 30}
        await expect(launches.startLaunch('larder')).rejects.toThrow('No launcher is running')
        launches.addLauncher('larder')
        const launch = await launches.startLaunch('larder')
        expect(launch).toMatchObject({project: 'larder', after: 41, minutes: 30, tmux: `orrery-larder-${launch.id}`})
        expect(sent).toEqual([{type: 'launch', after: 41, minutes: 30}])
        expect(launches.claim('larder', launch.id)).toBe(true)
        // The one on its way counts toward the limit, with those running.
        started = {larder: 1, all: 1}
        await expect(launches.startLaunch('larder')).rejects.toThrow('already has its 2 sessions at once')
        // Someone listening doesn't stop the owner starting another.
        listeners = 1
        launches.launched(launch.id)
        expect(await launches.startLaunch('larder')).toMatchObject({after: 41})
    })

    it('starts it focused on an issue, with a focus only that session hears', async () => {
        launches.addLauncher('larder')
        await expect(launches.startLaunch('larder', {issue: 'LAR-404'})).rejects.toThrow('No issue LAR-404')
        // A refused focus doesn't hold the project's place.
        expect(launches.launchState('larder').starting).toBe(0)
        const launch = await launches.startLaunch('larder', {issue: 'LAR-7'})
        expect(focused).toEqual([{issue: 'LAR-7', session: `launch-${launch.id}`}])
        // It catches up from the focus made for it.
        expect(launch.after).toBe(41)
        expect(sent).toEqual([{type: 'launch', after: 41, minutes: 30}])
    })

    it("starts it working through a scope: statuses, a release, or both, the open work that's ready by default", async () => {
        launches.addLauncher('larder')
        const launch = await launches.startLaunch('larder', {statuses: ['backlog', 'todo'], release: '1.0.0'})
        await launches.startLaunch('larder', {release: '1.0.0'})
        expect(scoped).toEqual([
            {chunk: 'all', body: {session: `launch-${launch.id}`, status: 'backlog,todo', release: '1.0.0'}},
            {chunk: 'all', body: expect.objectContaining({status: 'todo,started', release: '1.0.0'})},
        ])
        expect(launch.after).toBe(42)
    })
})

describe('a session Orrery started', () => {
    it('is stopped, or given longer from when it would have stopped, through its launcher', () => {
        expect(() => launches.stopLaunch('larder', 'abc')).toThrow('No session started for launch abc')
        session = {started: {launch: 'abc', tmux: 'orrery-larder-abc', stops_at: '2999-01-01T10:00:00.000Z'}}
        launches.stopLaunch('larder', 'abc')
        expect(launches.extendLaunchBy('larder', 'abc', 30).started!.stops_at).toBe('2999-01-01T10:30:00.000Z')
        expect(sent).toEqual([{type: 'stop', project: 'larder', id: 'abc'}, {type: 'extend', project: 'larder', id: 'abc', stops_at: '2999-01-01T10:30:00.000Z'}])
    })
})

describe('a launcher reporting the sessions it runs', () => {
    const running = {id: 'a1b2c3d4e5f6', tmux: 'orrery-larder-a1b2c3d4e5f6', stops_at: '2026-10-25T20:00:00.000Z'}

    it('has Orrery know them again after it restarted, whichever of the session and the report comes first', () => {
        // Before the report, a channel claiming the launch isn't known as started.
        expect(launches.launched(running.id)).toBeUndefined()
        launches.reportRunning('larder', [running])
        expect(adopted).toEqual([running.id])
        expect(launches.launched(running.id)).toEqual({launch: running.id, tmux: running.tmux, stops_at: running.stops_at})
    })

    it('keeps the stop time the owner moves, and forgets the launch once it has ended', () => {
        launches.reportRunning('larder', [running])
        session = {started: {launch: running.id, tmux: running.tmux, stops_at: running.stops_at}}
        vi.useFakeTimers({now: Date.parse('2026-10-25T19:00:00.000Z')})
        launches.extendLaunchBy('larder', running.id, 30)
        expect(launches.launched(running.id)?.stops_at).toBe('2026-10-25T20:30:00.000Z')
        launches.launchGone(running.id)
        expect(launches.launched(running.id)).toBeUndefined()
    })
})
