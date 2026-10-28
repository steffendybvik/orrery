import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal, Starts} from '#shared/roadmap'

// The launches live in the module, so each test gets a fresh one, with Nitro's auto-imports stubbed.
let launches: typeof import('../server/utils/launches')
let chatsEnded: string[]
let problems: [string, string | null][]
let noted: {level: string, kind: string, message: string}[]
let sent: {type: string, project?: string, id?: string, after?: number, minutes?: number, stops_at?: string}[]
let listeners: number
let started: {greenhouse: number, all: number}
let starts: Starts | undefined
let session: {name?: string, started?: {launch: string, tmux: string, stops_at?: string, context?: {presets: string[], text: string}}} | undefined
/** What the sessions are on, for stopping those that are done: issues in progress, and signals waiting, by session. */
let working: Record<string, string[]>
let waiting: string[]
/** Whether a signal for every session waits, heard by none yet. */
let waitingForAll: boolean
let adopted: string[]
let focused: {issue: string, session: string}[]
let scoped: {chunk: string, body: Record<string, unknown>}[]
let messages: {schedule: number, text: string, target?: string}[]

beforeEach(async () => {
    sent = []
    listeners = 0
    started = {greenhouse: 0, all: 0}
    starts = {limit: 2, minutes: 30}
    session = undefined
    adopted = []
    working = {}
    waiting = []
    waitingForAll = false
    const events = new EventEmitter()
    events.on('launches', event => sent.push(event.type === 'launch' ? {type: 'launch', after: event.launch.after, minutes: event.launch.minutes} : event))
    vi.stubGlobal('projectEvents', events)
    const {counter} = await import('../server/utils/events')
    vi.stubGlobal('counter', counter)
    vi.stubGlobal('listening', () => listeners)
    vi.stubGlobal('startedSessions', (project?: string) => project ? started.greenhouse : started.all)
    vi.stubGlobal('sessionOfLaunch', () => session)
    vi.stubGlobal('adoptLaunch', (_project: string, started: {launch: string}) => adopted.push(started.launch))
    vi.stubGlobal('extendLaunch', (_project: string, _id: string, stops_at: string) => ({...session, started: {...session!.started!, stops_at}}))
    vi.stubGlobal('notFound', (message: string) => Object.assign(new Error(message), {statusCode: 404}))
    vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
    vi.stubGlobal('chatEnded', (id: string) => chatsEnded.push(id))
    chatsEnded = []
    problems = []
    noted = []
    vi.stubGlobal('chatProblem', (id: string, problem: string | null) => problems.push([id, problem]))
    vi.stubGlobal('useEventLog', () => ({note: (entry: {level: string, kind: string, message: string}) => noted.push(entry)}))
    // A tick for reading the project, as the database gives, so signals can overlap.
    focused = []
    scoped = []
    messages = []
    vi.stubGlobal('useStore', () => ({
        starts: () => new Promise(resolve => setTimeout(() => resolve(starts), 0)),
        lastSignal: async () => 41,
        focus: async (_project: string, issue: string, body: {session: string}) => {
            if (issue === 'GRE-404') throw Object.assign(new Error('No issue GRE-404'), {statusCode: 404})
            focused.push({issue, session: body.session})
            return {id: 42}
        },
        focusChunk: async (_project: string, chunk: string, body: Record<string, unknown>) => {
            scoped.push({chunk, body})
            return {id: 43}
        },
        message: async (_project: string, schedule: number, text: string, _actor: unknown, target?: string) => {
            messages.push({schedule, text, target})
            return {id: 50}
        },
        presetsFor: async (_project: string, ids: number[]) => ids.map(id => ({id, name: `preset ${id}`, text: `Text ${id}.`})),
        workingOn: async (_project: string, ids: string[]) => ids.flatMap(id => working[id] ?? []),
        waiting: async (_project: string, ids: string[]) => waitingForAll || ids.some(id => waiting.includes(id)),
        waitingFor: async (_project: string, ids: string[]) => ids.some(id => waiting.includes(id)),
    }))
    vi.stubGlobal('sessionIds', (id: string) => [id])
    vi.resetModules()
    launches = await import('../server/utils/launches')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

const signal = (id: number, more: Partial<Signal> = {}) => ({id, project: 'greenhouse', kind: 'focus', protected: true, delivered_to: [], ...more}) as Signal

describe('starting a session', () => {
    it("happens for the owner's signal that nobody is listening for, once a launcher is there", async () => {
        expect(await launches.considerLaunch(signal(5))).toBeNull()
        const done = launches.addLauncher('greenhouse')
        expect(await launches.considerLaunch(signal(6, {protected: false}))).toBeNull()
        listeners = 1
        expect(await launches.considerLaunch(signal(6))).toBeNull()
        listeners = 0
        const launch = await launches.considerLaunch(signal(7))
        expect(launch).toMatchObject({project: 'greenhouse', after: 6, minutes: 30, tmux: `orrery-greenhouse-${launch!.id}`})
        expect(sent).toEqual([{type: 'launch', after: 6, minutes: 30}])
        // The launch on its way covers what comes after it, until its session connects.
        expect(await launches.considerLaunch(signal(8))).toBeNull()
        expect(launches.launchState('greenhouse')).toEqual({launchers: 1, folders: [], every: false, started: 0, starting: 1, total: 1})
        expect(launches.launched(launch!.id)).toMatchObject({launch: launch!.id, tmux: launch!.tmux})
        started = {greenhouse: 1, all: 1}
        expect(await launches.considerLaunch(signal(9))).not.toBeNull()
        done()
        expect(launches.launchState('greenhouse').launchers).toBe(0)
    })

    it("isn't for a signal aimed at one session, or one that's been delivered", async () => {
        launches.addLauncher('greenhouse')
        expect(await launches.considerLaunch(signal(1, {target: 'window-a'}))).toBeNull()
        expect(await launches.considerLaunch(signal(1, {delivered_to: ['greenhouse 1']}))).toBeNull()
        expect(sent).toEqual([])
    })

    it('starts one session for signals that come together', async () => {
        launches.addLauncher('greenhouse')
        const both = await Promise.all([launches.considerLaunch(signal(1)), launches.considerLaunch(signal(2))])
        expect(both.filter(Boolean)).toHaveLength(1)
        expect(sent).toHaveLength(1)
    })

    it('goes to the first launcher that claims it', async () => {
        launches.addLauncher('greenhouse')
        launches.addLauncher('greenhouse')
        const launch = (await launches.considerLaunch(signal(1)))!
        expect([launches.claim('greenhouse', launch.id), launches.claim('greenhouse', launch.id), launches.claim('mesa', launch.id)]).toEqual([true, false, false])
        expect(launches.claim('greenhouse', 'nope')).toBe(false)
    })

    it("needs the owner's opt-in, and stays within the limit, counting every project's sessions", async () => {
        launches.addLauncher('greenhouse')
        starts = undefined
        expect(await launches.considerLaunch(signal(1))).toBeNull()
        starts = {limit: 2, minutes: 30}
        started = {greenhouse: 0, all: 2}
        expect(await launches.considerLaunch(signal(2))).toBeNull()
        started = {greenhouse: 0, all: 1}
        expect(await launches.considerLaunch(signal(3))).not.toBeNull()
        // A refused launch isn't left holding the project's place.
        expect(launches.launchState('greenhouse').starting).toBe(1)
    })

    it('lets a launch go whose session never connects', async () => {
        launches.addLauncher('greenhouse')
        expect(await launches.considerLaunch(signal(1))).not.toBeNull()
        expect(await launches.considerLaunch(signal(2))).toBeNull()
        vi.useFakeTimers({now: Date.now() + 3 * 60 * 1000 + 1000, toFake: ['Date']})
        expect(await launches.considerLaunch(signal(3))).not.toBeNull()
    })

    it('lets a launch go at once when it ends before its session connects', async () => {
        launches.addLauncher('greenhouse')
        const launch = (await launches.considerLaunch(signal(1)))!
        launches.launchGone(launch.id)
        expect(launches.launchState('greenhouse').starting).toBe(0)
        expect(await launches.considerLaunch(signal(2))).not.toBeNull()
    })
})

describe('the owner starting a session by hand', () => {
    it("catches up from the latest signal, given the owner's opt-in, a launcher and room under its limit", async () => {
        starts = undefined
        await expect(launches.startLaunch('greenhouse')).rejects.toThrow("Orrery doesn't start sessions")
        starts = {limit: 2, minutes: 30}
        await expect(launches.startLaunch('greenhouse')).rejects.toThrow('No launcher is running')
        launches.addLauncher('greenhouse')
        const launch = await launches.startLaunch('greenhouse')
        expect(launch).toMatchObject({project: 'greenhouse', after: 41, minutes: 30, tmux: `orrery-greenhouse-${launch.id}`})
        expect(sent).toEqual([{type: 'launch', after: 41, minutes: 30}])
        expect(launches.claim('greenhouse', launch.id)).toBe(true)
        // The one on its way counts toward the limit, with those running.
        started = {greenhouse: 1, all: 1}
        await expect(launches.startLaunch('greenhouse')).rejects.toThrow('Orrery already has its 2 sessions at once')
        // Someone listening doesn't stop the owner starting another.
        listeners = 1
        launches.launched(launch.id)
        expect(await launches.startLaunch('greenhouse')).toMatchObject({after: 41})
    })

    it("is refused once other projects' sessions fill the limit", async () => {
        launches.addLauncher('greenhouse')
        started = {greenhouse: 0, all: 2}
        await expect(launches.startLaunch('greenhouse')).rejects.toThrow('Orrery already has its 2 sessions at once')
        expect(launches.launchState('greenhouse')).toEqual({launchers: 1, folders: [], every: false, started: 0, starting: 0, total: 2})
    })

    it('starts one session hearing several projects only when their launchers share a folder', async () => {
        const greenhouse = launches.addLauncher('greenhouse', '/src/mono')
        launches.addLauncher('pantry', '/src/mono')
        launches.addLauncher('shop', '/src/shop')
        expect(launches.launchState('greenhouse').folders).toEqual(['/src/mono'])
        await expect(launches.startLaunch('greenhouse', {hears: ['pantry', 'shop']})).rejects.toThrow("shop isn't served from greenhouse's repo")
        expect(launches.launchState('greenhouse').starting).toBe(0)
        // Its own project first, once, whatever order they're sent in.
        expect(await launches.startLaunch('greenhouse', {hears: ['pantry', 'greenhouse', 'pantry']})).toMatchObject({hears: ['greenhouse', 'pantry']})
        // One project alone needs no folder in common, nor a launcher that says its folder (an older one).
        launches.addLauncher('attic')
        expect(await launches.startLaunch('attic', {hears: ['attic']})).toMatchObject({hears: ['attic']})
        greenhouse()
        expect(launches.launchState('greenhouse').folders).toEqual([])
    })

    it('says when a launcher serves every project, so a launch without hears hears them all', async () => {
        const plain = launches.addLauncher('greenhouse', '/src/mono')
        expect(launches.launchState('greenhouse').every).toBe(false)
        const every = launches.addLauncher('greenhouse', '/src/mono', true)
        expect(launches.launchState('greenhouse').every).toBe(true)
        expect(await launches.startLaunch('greenhouse')).not.toHaveProperty('hears')
        every()
        every()
        expect(launches.launchState('greenhouse')).toMatchObject({launchers: 1, every: false, folders: ['/src/mono']})
        plain()
    })

    it('starts it focused on an issue, with a focus only that session hears', async () => {
        launches.addLauncher('greenhouse')
        await expect(launches.startLaunch('greenhouse', {issue: 'GRE-404'})).rejects.toThrow('No issue GRE-404')
        // A refused focus doesn't hold the project's place.
        expect(launches.launchState('greenhouse').starting).toBe(0)
        const launch = await launches.startLaunch('greenhouse', {issue: 'GRE-7'})
        expect(focused).toEqual([{issue: 'GRE-7', session: `launch-${launch.id}`}])
        // It catches up from the focus made for it.
        expect(launch.after).toBe(41)
        expect(sent).toEqual([{type: 'launch', after: 41, minutes: 30}])
    })

    it("starts it working through a scope: statuses, a release, or both, the open work that's ready by default", async () => {
        launches.addLauncher('greenhouse')
        const launch = await launches.startLaunch('greenhouse', {statuses: ['backlog', 'todo'], release: '1.0.0'})
        await launches.startLaunch('greenhouse', {release: '1.0.0'})
        expect(scoped).toEqual([
            {chunk: 'all', body: {session: `launch-${launch.id}`, status: 'backlog,todo', release: '1.0.0'}},
            {chunk: 'all', body: expect.objectContaining({status: 'todo,started', release: '1.0.0'})},
        ])
        expect(launch.after).toBe(42)
    })
})

describe('the context a session is started with', () => {
    it('joins the presets picked, then the owner\'s own words; none when there are neither', async () => {
        expect(await launches.contextFor('greenhouse')).toBeUndefined()
        expect(await launches.contextFor('greenhouse', [], '  ')).toBeUndefined()
        expect(await launches.contextFor('greenhouse', [2, 1], ' Be brief. ')).toEqual({presets: ['preset 2', 'preset 1'], instructions: 'Be brief.', text: 'Text 2.\n\nText 1.\n\nBe brief.'})
    })

    it('goes with the launch to its launcher and its session, and stays known while the launch is', async () => {
        launches.addLauncher('greenhouse')
        const context = {presets: ['Review'], text: "You're reviewing."}
        const launch = await launches.startLaunch('greenhouse', {context})
        expect(launch.context).toEqual(context)
        // Its hook asks before its channel has connected.
        expect(launches.launchContext('greenhouse', launch.id)).toEqual(context)
        expect(launches.launchContext('pantry', launch.id)).toBeUndefined()
        const started = launches.launched(launch.id)!
        expect(started.context).toEqual(context)
        session = {started}
        expect(launches.launchContext('greenhouse', launch.id)).toEqual(context)
        expect(launches.contextBlock(context)).toMatch(/more context as they started it.*\n\nYou're reviewing\.$/s)
    })

    it("is taken from a launcher's report only for a launch Orrery has forgotten", () => {
        const running = {id: 'a1b2c3d4e5f6', tmux: 'orrery-greenhouse-a1b2c3d4e5f6', stops_at: '2026-10-25T20:00:00.000Z'}
        launches.reportRunning('greenhouse', [{...running, context: {presets: [], text: 'Kept by the launcher.'}}])
        expect(launches.launched(running.id)?.context?.text).toBe('Kept by the launcher.')
        launches.reportRunning('greenhouse', [{...running, context: {presets: [], text: 'Something else.'}}])
        expect(launches.launchContext('greenhouse', running.id)?.text).toBe('Kept by the launcher.')
    })
})

describe('a session Orrery started', () => {
    it('is opened in a terminal by its launcher when the owner watches it', () => {
        expect(() => launches.watchLaunch('greenhouse', 'abc', 'warp')).toThrow('No session started for launch abc')
        session = {started: {launch: 'abc', tmux: 'orrery-greenhouse-abc', stops_at: '2999-01-01T10:00:00.000Z'}}
        expect(() => launches.watchLaunch('greenhouse', 'abc', 'warp')).toThrow('attach by hand with tmux attach -t orrery-greenhouse-abc')
        launches.addLauncher('greenhouse')
        launches.watchLaunch('greenhouse', 'abc', 'warp')
        expect(sent).toEqual([{type: 'watch', project: 'greenhouse', id: 'abc', terminal: 'warp'}])
    })

    it('has its screen sent by its launcher while the owner views it, and asked for again once stale', () => {
        expect(() => launches.viewLaunch('greenhouse', 'abc')).toThrow('No session started for launch abc')
        session = {started: {launch: 'abc', tmux: 'orrery-greenhouse-abc'}}
        expect(() => launches.viewLaunch('greenhouse', 'abc')).toThrow('attach by hand with tmux attach -t orrery-greenhouse-abc')
        launches.addLauncher('greenhouse')
        expect(launches.viewLaunch('greenhouse', 'abc', 1000)).toEqual({screen: null})
        // Asked once, not on every poll while the first screen is on its way.
        expect(launches.viewLaunch('greenhouse', 'abc', 2000)).toEqual({screen: null})
        expect(sent).toEqual([{type: 'view', project: 'greenhouse', id: 'abc'}])
        expect(launches.keepScreen('greenhouse', 'abc', '> working', 2500)).toEqual({watching: true})
        expect(launches.viewLaunch('greenhouse', 'abc', 3000)).toEqual({screen: '> working', at: new Date(2500).toISOString()})
        // The launcher stopped sending: a stale screen is asked for again.
        expect(launches.viewLaunch('greenhouse', 'abc', 7000).screen).toBe('> working')
        expect(sent).toHaveLength(2)
        // Nobody viewing: the launcher stops, and the screen isn't kept.
        expect(launches.keepScreen('greenhouse', 'abc', '> done', 7000 + launches.VIEW_FOR)).toEqual({watching: false})
        launches.launchGone('abc')
        expect(launches.viewLaunch('greenhouse', 'abc', 20_000)).toEqual({screen: null})
    })

    it('keeps no screen for a launch it has no session for', () => {
        expect(launches.keepScreen('greenhouse', 'abc', 'anything')).toEqual({watching: false})
    })

    it('is stopped, or given longer from when it would have stopped, through its launcher', () => {
        expect(() => launches.stopLaunch('greenhouse', 'abc')).toThrow('No session started for launch abc')
        session = {started: {launch: 'abc', tmux: 'orrery-greenhouse-abc', stops_at: '2999-01-01T10:00:00.000Z'}}
        launches.stopLaunch('greenhouse', 'abc')
        expect(launches.extendLaunchBy('greenhouse', 'abc', 30).started!.stops_at).toBe('2999-01-01T10:30:00.000Z')
        expect(sent).toEqual([{type: 'stop', project: 'greenhouse', id: 'abc'}, {type: 'extend', project: 'greenhouse', id: 'abc', stops_at: '2999-01-01T10:30:00.000Z'}])
    })

    it('runs until stopped when the project gives no minutes, with no time to extend', async () => {
        starts = {limit: 2}
        launches.addLauncher('greenhouse')
        const launch = (await launches.considerLaunch(signal(1)))!
        expect(launch.minutes).toBeUndefined()
        expect(launches.launched(launch.id)).toEqual({launch: launch.id, tmux: launch.tmux})
        session = {name: 'greenhouse 1', started: {launch: 'abc', tmux: 'orrery-greenhouse-abc'}}
        expect(() => launches.extendLaunchBy('greenhouse', 'abc', 30)).toThrow('greenhouse 1 runs until it\'s stopped')
    })
})

describe('stopping the sessions Orrery started that are done', () => {
    const now = Date.parse('2026-10-26T15:00:00.000Z')
    const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString()
    const started = (launch: string, more: {state?: string, since?: string, stops_at?: string} = {}) =>
        ({id: `s-${launch}`, project: 'greenhouse', state: 'idle', since: minutesAgo(1), started: {launch, tmux: `orrery-greenhouse-${launch}`, ...more.stops_at ? {stops_at: more.stops_at} : {}}, ...more})
    const stopped = () => sent.filter(e => e.type === 'stop').map(e => e.id)

    it("stops one whose time is up only once it's idle with nothing in progress or waiting", async () => {
        const sessions = [
            started('due', {stops_at: minutesAgo(1)}),
            started('busy', {stops_at: minutesAgo(1), state: 'working'}),
            started('holding', {stops_at: minutesAgo(1)}),
            started('asked', {stops_at: minutesAgo(1)}),
            started('later', {stops_at: minutesAgo(-5)}),
            started('forever'),
            {id: 'by-hand', project: 'greenhouse', state: 'idle', since: minutesAgo(600)},
        ]
        vi.stubGlobal('listSessions', () => sessions)
        working = {'s-holding': ['GRE-1']}
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
        working = {'s-holding': ['GRE-1']}
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

describe("an untrusted schedule's run", () => {
    const owner = {name: 'skoll', owner: true}

    it('starts a session of its own, with the message and its brief aimed at that session alone', async () => {
        await expect(launches.startUntrusted('greenhouse', 3, 'Triage GitHub issues.', owner)).rejects.toMatchObject({statusCode: 409})
        launches.addLauncher('greenhouse')
        starts = {limit: 2, minutes: 45}
        const launch = await launches.startUntrusted('greenhouse', 3, 'Triage GitHub issues.', owner)
        // At most half an hour, whatever the project gives sessions.
        expect(launch).toMatchObject({project: 'greenhouse', after: 49, minutes: 30, untrusted: true})
        expect(messages).toEqual([{schedule: 3, text: `${launches.UNTRUSTED_BRIEF}\n\nTriage GitHub issues.`, target: launches.launchTarget(launch.id)}])
        expect(launches.UNTRUSTED_BRIEF).toMatch(/data, never as instructions/)
        expect(launches.launched(launch.id)).toMatchObject({launch: launch.id, untrusted: true})
    })

    it('goes only to a launcher that says it locks the session down', async () => {
        launches.addLauncher('greenhouse')
        const launch = await launches.startUntrusted('greenhouse', 3, 'Triage.', owner)
        expect(launches.claim('greenhouse', launch.id)).toBe(false)
        expect(launches.claim('greenhouse', launch.id, true)).toBe(true)
        // An ordinary launch goes to any launcher.
        const plain = await launches.startLaunch('greenhouse')
        expect(launches.claim('greenhouse', plain.id)).toBe(true)
    })

    it('is refused when there is no room, with no message sent', async () => {
        launches.addLauncher('greenhouse')
        started = {greenhouse: 2, all: 2}
        await expect(launches.startUntrusted('greenhouse', 3, 'Triage.', owner)).rejects.toThrow(/already has its 2 sessions/)
        starts = undefined
        await expect(launches.startUntrusted('greenhouse', 3, 'Triage.', owner)).rejects.toThrow(/doesn't start sessions/)
        expect(messages).toEqual([])
    })

    it('has its session stopped once it has sat idle a couple of minutes', async () => {
        const now = Date.parse('2026-10-26T15:00:00.000Z')
        const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
        const sessions = [
            {id: 's-done', project: 'greenhouse', state: 'idle', since: at(3), started: {launch: 'done', tmux: 't', untrusted: true}},
            {id: 's-new', project: 'greenhouse', state: 'idle', since: at(1), started: {launch: 'new', tmux: 't', untrusted: true}},
            {id: 's-plain', project: 'greenhouse', state: 'idle', since: at(3), started: {launch: 'plain', tmux: 't'}},
        ]
        vi.stubGlobal('listSessions', () => sessions)
        expect(await launches.stopDue(now)).toEqual(['done'])
    })

    it("is stopped when idle though a signal for every session waits, as none reaches it", async () => {
        const now = Date.parse('2026-10-26T15:00:00.000Z')
        const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
        waitingForAll = true
        vi.stubGlobal('listSessions', () => [
            {id: 's-locked', project: 'greenhouse', state: 'idle', since: at(3), started: {launch: 'locked', tmux: 't', untrusted: true}},
            {id: 's-plain', project: 'greenhouse', state: 'idle', since: at(40), started: {launch: 'plain', tmux: 't', stops_at: at(1)}},
        ])
        expect(await launches.stopDue(now)).toEqual(['locked'])
    })

    it('makes what its session raises a proposal labelled external, and nothing more', async () => {
        const {asProposal} = await import('../server/utils/untrusted')
        expect(asProposal({title: 'Crash on save', notes: 'From #12', labels: ['bug'], priority: 'P0', status: 'in-progress', assignee: 'claude', parent: 'GRE-1', chunk: '2', release: '1.0.0'}))
            .toEqual({title: 'Crash on save', notes: 'From #12', proposal: 'pending', labels: ['bug', 'external']})
        expect(asProposal({title: 'x', labels: ['external']}).labels).toEqual(['external'])
        expect(asProposal(null)).toMatchObject({proposal: 'pending', labels: ['external']})
    })

    it("stays untrusted when a launcher reports it after Orrery restarted", () => {
        launches.reportRunning('greenhouse', [{id: 'a1b2c3d4e5f6', tmux: 'orrery-greenhouse-a1b2c3d4e5f6', untrusted: true}])
        expect(launches.launched('a1b2c3d4e5f6')).toMatchObject({untrusted: true})
    })
})

describe("the owner's chat", () => {
    const context = {presets: [], text: 'This session is the owner\'s chat.'}

    it('starts a session of its own, told what it is, until the owner ends it, whatever the project gives sessions', async () => {
        await expect(launches.startChat('greenhouse', context)).rejects.toMatchObject({statusCode: 409})
        launches.addLauncher('greenhouse')
        const launch = await launches.startChat('greenhouse', context)
        expect(launch).toMatchObject({project: 'greenhouse', after: 41, chat: true, context})
        expect(launch.minutes).toBeUndefined()
        expect(launches.launched(launch.id)).toMatchObject({launch: launch.id, chat: true, context})
    })

    it('counts towards nothing: it starts with starts turned off or the limit full, and takes up no room', async () => {
        launches.addLauncher('greenhouse')
        starts = undefined
        await launches.startChat('greenhouse', context)
        starts = {limit: 1}
        started = {greenhouse: 1, all: 1}
        await launches.startChat('greenhouse', context)
        expect(launches.launchState('greenhouse')).toMatchObject({starting: 0, total: 1})
    })

    it('says it stops as a chat, so the log leaves it out', async () => {
        launches.addLauncher('greenhouse')
        const launch = await launches.startChat('greenhouse', context)
        launches.endLaunch('greenhouse', launch.id, true)
        expect(sent.at(-1)).toEqual({type: 'stop', project: 'greenhouse', id: launch.id, chat: true})
    })

    it('goes only to a launcher that says it starts chats', async () => {
        launches.addLauncher('greenhouse')
        const launch = await launches.startChat('greenhouse', context)
        expect(launches.claim('greenhouse', launch.id, true)).toBe(false)
        expect(launches.claim('greenhouse', launch.id, true, true)).toBe(true)
    })

    it('says a launcher too old to start it was refused, once, and lets that go as its session connects', async () => {
        launches.addLauncher('greenhouse')
        const launch = await launches.startChat('greenhouse', context)
        // A launcher from before chats claims as it always did, and again on its next try.
        expect(launches.claim('greenhouse', launch.id, true)).toBe(false)
        expect(launches.claim('greenhouse', launch.id, true)).toBe(false)
        expect(noted).toEqual([expect.objectContaining({level: 'warn', kind: 'launcher.outdated', message: expect.stringMatching(/start a chat.*Restart the launcher/)})])
        expect(problems).toEqual([[launch.id, noted[0]!.message]])
        // Restarted on the new code, it takes the chat on, and the chat stops saying so.
        expect(launches.claim('greenhouse', launch.id, true, true)).toBe(true)
        launches.launched(launch.id)
        expect(problems.at(-1)).toEqual([launch.id, null])
    })

    it("isn't stopped for sitting idle, nor for its time", async () => {
        starts = {limit: 2, idle_minutes: 1}
        const now = Date.parse('2026-10-26T15:00:00.000Z')
        const long = new Date(now - 120 * 60_000).toISOString()
        vi.stubGlobal('listSessions', () => [{id: 's-chat', project: 'greenhouse', state: 'idle', since: long, started: {launch: 'chat', tmux: 't', chat: true, stops_at: long}}])
        expect(await launches.stopDue(now)).toEqual([])
    })

    it('ends, on its way or running, and its chat with it', async () => {
        launches.addLauncher('greenhouse')
        const launch = await launches.startChat('greenhouse', context)
        launches.endLaunch('greenhouse', launch.id)
        expect(sent.at(-1)).toEqual({type: 'stop', project: 'greenhouse', id: launch.id})
        expect(launches.claim('greenhouse', launch.id, true, true)).toBe(false)
        launches.launchGone(launch.id)
        expect(chatsEnded).toEqual([launch.id])
    })

    it('stays a chat when a launcher reports it after Orrery restarted', () => {
        launches.reportRunning('greenhouse', [{id: 'c1c2c3c4c5c6', tmux: 'orrery-greenhouse-c1c2c3c4c5c6', chat: true}])
        expect(launches.launched('c1c2c3c4c5c6')).toMatchObject({chat: true})
    })
})

describe('a launcher reporting the sessions it runs', () => {
    const running = {id: 'a1b2c3d4e5f6', tmux: 'orrery-greenhouse-a1b2c3d4e5f6', stops_at: '2026-10-25T20:00:00.000Z'}

    it('has Orrery know them again after it restarted, whichever of the session and the report comes first', () => {
        // Before the report, a channel claiming the launch isn't known as started.
        expect(launches.launched(running.id)).toBeUndefined()
        const forever = {id: 'f1f2f3f4f5f6', tmux: 'orrery-greenhouse-f1f2f3f4f5f6'}
        launches.reportRunning('greenhouse', [running, forever])
        expect(adopted).toEqual([running.id, forever.id])
        expect(launches.launched(running.id)).toEqual({launch: running.id, tmux: running.tmux, stops_at: running.stops_at})
        expect(launches.launched(forever.id)).toEqual({launch: forever.id, tmux: forever.tmux})
    })

    it('keeps the stop time the owner moves, and forgets the launch once it has ended', () => {
        launches.reportRunning('greenhouse', [running])
        session = {started: {launch: running.id, tmux: running.tmux, stops_at: running.stops_at}}
        vi.useFakeTimers({now: Date.parse('2026-10-25T19:00:00.000Z')})
        launches.extendLaunchBy('greenhouse', running.id, 30)
        expect(launches.launched(running.id)?.stops_at).toBe('2026-10-25T20:30:00.000Z')
        launches.launchGone(running.id)
        expect(launches.launched(running.id)).toBeUndefined()
    })
})
