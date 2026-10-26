import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal, Starts} from '#shared/roadmap'

// The launches live in the module, so each test gets a fresh one, with Nitro's auto-imports stubbed.
let launches: typeof import('../server/utils/launches')
let sent: {type: string, project?: string, id?: string, after?: number, minutes?: number, stops_at?: string}[]
let listeners: number
let started: {larder: number, all: number}
let starts: Starts | undefined
let session: {name?: string, started?: {launch: string, tmux: string, stops_at?: string, context?: {presets: string[], text: string}}} | undefined
/** What the sessions are on, for stopping those that are done: issues in progress, and signals waiting, by session. */
let working: Record<string, string[]>
let waiting: string[]
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
    working = {}
    waiting = []
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
        presetsFor: async (_project: string, ids: number[]) => ids.map(id => ({id, name: `preset ${id}`, text: `Text ${id}.`})),
        workingOn: async (_project: string, ids: string[]) => ids.flatMap(id => working[id] ?? []),
        waiting: async (_project: string, ids: string[]) => ids.some(id => waiting.includes(id)),
    }))
    vi.stubGlobal('sessionIds', (id: string) => [id])
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
    it("catches up from the latest signal, given the owner's opt-in, a launcher and room under its limit", async () => {
        starts = undefined
        await expect(launches.startLaunch('larder')).rejects.toThrow("Orrery doesn't start sessions")
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

describe('the context a session is started with', () => {
    it('joins the presets picked, then the owner\'s own words; none when there are neither', async () => {
        expect(await launches.contextFor('larder')).toBeUndefined()
        expect(await launches.contextFor('larder', [], '  ')).toBeUndefined()
        expect(await launches.contextFor('larder', [2, 1], ' Be brief. ')).toEqual({presets: ['preset 2', 'preset 1'], instructions: 'Be brief.', text: 'Text 2.\n\nText 1.\n\nBe brief.'})
    })

    it('goes with the launch to its launcher and its session, and stays known while the launch is', async () => {
        launches.addLauncher('larder')
        const context = {presets: ['Review'], text: "You're reviewing."}
        const launch = await launches.startLaunch('larder', {context})
        expect(launch.context).toEqual(context)
        // Its hook asks before its channel has connected.
        expect(launches.launchContext('larder', launch.id)).toEqual(context)
        expect(launches.launchContext('pantry', launch.id)).toBeUndefined()
        const started = launches.launched(launch.id)!
        expect(started.context).toEqual(context)
        session = {started}
        expect(launches.launchContext('larder', launch.id)).toEqual(context)
        expect(launches.contextBlock(context)).toMatch(/more context as they started it.*\n\nYou're reviewing\.$/s)
    })

    it("is taken from a launcher's report only for a launch Orrery has forgotten", () => {
        const running = {id: 'a1b2c3d4e5f6', tmux: 'orrery-larder-a1b2c3d4e5f6', stops_at: '2026-10-25T20:00:00.000Z'}
        launches.reportRunning('larder', [{...running, context: {presets: [], text: 'Kept by the launcher.'}}])
        expect(launches.launched(running.id)?.context?.text).toBe('Kept by the launcher.')
        launches.reportRunning('larder', [{...running, context: {presets: [], text: 'Something else.'}}])
        expect(launches.launchContext('larder', running.id)?.text).toBe('Kept by the launcher.')
    })
})

describe('a session Orrery started', () => {
    it('is opened in a terminal by its launcher when the owner watches it', () => {
        expect(() => launches.watchLaunch('larder', 'abc', 'warp')).toThrow('No session started for launch abc')
        session = {started: {launch: 'abc', tmux: 'orrery-larder-abc', stops_at: '2999-01-01T10:00:00.000Z'}}
        expect(() => launches.watchLaunch('larder', 'abc', 'warp')).toThrow('attach by hand with tmux attach -t orrery-larder-abc')
        launches.addLauncher('larder')
        launches.watchLaunch('larder', 'abc', 'warp')
        expect(sent).toEqual([{type: 'watch', project: 'larder', id: 'abc', terminal: 'warp'}])
    })

    it('is stopped, or given longer from when it would have stopped, through its launcher', () => {
        expect(() => launches.stopLaunch('larder', 'abc')).toThrow('No session started for launch abc')
        session = {started: {launch: 'abc', tmux: 'orrery-larder-abc', stops_at: '2999-01-01T10:00:00.000Z'}}
        launches.stopLaunch('larder', 'abc')
        expect(launches.extendLaunchBy('larder', 'abc', 30).started!.stops_at).toBe('2999-01-01T10:30:00.000Z')
        expect(sent).toEqual([{type: 'stop', project: 'larder', id: 'abc'}, {type: 'extend', project: 'larder', id: 'abc', stops_at: '2999-01-01T10:30:00.000Z'}])
    })

    it('runs until stopped when the project gives no minutes, with no time to extend', async () => {
        starts = {limit: 2}
        launches.addLauncher('larder')
        const launch = (await launches.considerLaunch(signal(1)))!
        expect(launch.minutes).toBeUndefined()
        expect(launches.launched(launch.id)).toEqual({launch: launch.id, tmux: launch.tmux})
        session = {name: 'larder 1', started: {launch: 'abc', tmux: 'orrery-larder-abc'}}
        expect(() => launches.extendLaunchBy('larder', 'abc', 30)).toThrow('larder 1 runs until it\'s stopped')
    })
})

describe('stopping the sessions Orrery started that are done', () => {
    const now = Date.parse('2026-10-26T15:00:00.000Z')
    const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString()
    const started = (launch: string, more: {state?: string, since?: string, stops_at?: string} = {}) =>
        ({id: `s-${launch}`, project: 'larder', state: 'idle', since: minutesAgo(1), started: {launch, tmux: `orrery-larder-${launch}`, ...more.stops_at ? {stops_at: more.stops_at} : {}}, ...more})
    const stopped = () => sent.filter(e => e.type === 'stop').map(e => e.id)

    it("stops one whose time is up only once it's idle with nothing in progress or waiting", async () => {
        const sessions = [
            started('due', {stops_at: minutesAgo(1)}),
            started('busy', {stops_at: minutesAgo(1), state: 'working'}),
            started('holding', {stops_at: minutesAgo(1)}),
            started('asked', {stops_at: minutesAgo(1)}),
            started('later', {stops_at: minutesAgo(-5)}),
            started('forever'),
            {id: 'by-hand', project: 'larder', state: 'idle', since: minutesAgo(600)},
        ]
        vi.stubGlobal('listSessions', () => sessions)
        working = {'s-holding': ['LAR-1']}
        waiting = ['s-asked']
        expect(await launches.stopDue(now)).toEqual(['due'])
        // Done with its issue, the one holding it goes at the next check; the busy one once it's idle.
        working = {}
        sessions[1]!.state = 'idle'
        expect(await launches.stopDue(now + 30_000)).toEqual(['busy', 'holding'])
        expect(stopped()).toEqual(['due', 'busy', 'holding'])
    })

    it('stops one long past its time anyway, whatever it is doing', async () => {
        starts = {limit: 2, minutes: 20}
        const sessions = [
            started('stuck', {stops_at: minutesAgo(21), state: 'waiting'}),
            started('looping', {stops_at: minutesAgo(25), state: 'working'}),
            started('holding', {stops_at: minutesAgo(30)}),
            started('nearly', {stops_at: minutesAgo(19), state: 'working'}),
        ]
        vi.stubGlobal('listSessions', () => sessions)
        working = {'s-holding': ['LAR-1']}
        // 20 minutes over: its minutes again. One just past its time and still busy is let finish.
        expect(await launches.stopDue(now)).toEqual(['stuck', 'looping', 'holding'])
        expect(launches.overdueAfter(5)).toBe(15 * 60_000)
        expect(launches.overdueAfter(240)).toBe(60 * 60_000)
        expect(launches.overdueAfter()).toBe(30 * 60_000)
    })

    it("stops one idle for the project's idle minutes, from when it went idle, and asks a slow launcher again later", async () => {
        starts = {limit: 2, idle_minutes: 60}
        const sessions = [started('idle', {since: minutesAgo(61)}), started('fresh', {since: minutesAgo(59)}), started('working', {state: 'working', since: minutesAgo(120)})]
        vi.stubGlobal('listSessions', () => sessions)
        expect(await launches.stopDue(now)).toEqual(['idle'])
        expect(await launches.stopDue(now + 30_000)).toEqual([])
        expect(await launches.stopDue(now + 3 * 60_000)).toEqual(['idle', 'fresh'])
        // Without idle minutes, an idle session runs on.
        starts = {limit: 2}
        launches.launchGone('idle')
        launches.launchGone('fresh')
        expect(await launches.stopDue(now + 6 * 60_000)).toEqual([])
    })
})

describe('a launcher reporting the sessions it runs', () => {
    const running = {id: 'a1b2c3d4e5f6', tmux: 'orrery-larder-a1b2c3d4e5f6', stops_at: '2026-10-25T20:00:00.000Z'}

    it('has Orrery know them again after it restarted, whichever of the session and the report comes first', () => {
        // Before the report, a channel claiming the launch isn't known as started.
        expect(launches.launched(running.id)).toBeUndefined()
        const forever = {id: 'f1f2f3f4f5f6', tmux: 'orrery-larder-f1f2f3f4f5f6'}
        launches.reportRunning('larder', [running, forever])
        expect(adopted).toEqual([running.id, forever.id])
        expect(launches.launched(running.id)).toEqual({launch: running.id, tmux: running.tmux, stops_at: running.stops_at})
        expect(launches.launched(forever.id)).toEqual({launch: forever.id, tmux: forever.tmux})
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
