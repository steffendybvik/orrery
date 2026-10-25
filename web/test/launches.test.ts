import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal, Starts} from '#shared/roadmap'

// The launches live in the module, so each test gets a fresh one, with Nitro's auto-imports stubbed.
let launches: typeof import('../server/utils/launches')
let sent: {type: string, project?: string, id?: string, after?: number, minutes?: number, stopsAt?: string}[]
let listeners: number
let started: {larder: number, all: number}
let starts: Starts | undefined
let sessionLimit: number
let session: {started?: {launch: string, tmux: string, stopsAt: string}} | undefined

beforeEach(async () => {
    sent = []
    listeners = 0
    started = {larder: 0, all: 0}
    starts = {limit: 2, minutes: 30}
    sessionLimit = 3
    session = undefined
    const events = new EventEmitter()
    events.on('launches', event => sent.push(event.type === 'launch' ? {type: 'launch', after: event.launch.after, minutes: event.launch.minutes} : event))
    vi.stubGlobal('projectEvents', events)
    const {counter} = await import('../server/utils/events')
    vi.stubGlobal('counter', counter)
    vi.stubGlobal('listening', () => listeners)
    vi.stubGlobal('startedSessions', (project?: string) => project ? started.larder : started.all)
    vi.stubGlobal('sessionOfLaunch', () => session)
    vi.stubGlobal('extendLaunch', (_project: string, _id: string, stopsAt: string) => ({...session, started: {...session!.started!, stopsAt}}))
    vi.stubGlobal('notFound', (message: string) => Object.assign(new Error(message), {statusCode: 404}))
    // A tick between reading the project and the settings, as the database gives, so signals can overlap.
    const tick = <T>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 0))
    vi.stubGlobal('useStore', () => ({starts: () => tick(starts), settings: () => tick({sessionLimit})}))
    vi.resetModules()
    launches = await import('../server/utils/launches')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

const signal = (id: number, more: Partial<Signal> = {}) => ({id, project: 'larder', kind: 'focus', protected: true, deliveredTo: [], ...more}) as Signal

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

    it("needs the owner's opt-in, and stays within the project's limit and the Orrery's", async () => {
        launches.addLauncher('larder')
        starts = undefined
        expect(await launches.considerLaunch(signal(1))).toBeNull()
        starts = {limit: 2, minutes: 30}
        started = {larder: 2, all: 2}
        expect(await launches.considerLaunch(signal(2))).toBeNull()
        started = {larder: 1, all: 3}
        expect(await launches.considerLaunch(signal(3))).toBeNull()
        sessionLimit = 4
        expect(await launches.considerLaunch(signal(4))).not.toBeNull()
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
})

describe('a session Orrery started', () => {
    it('is stopped, or given longer from when it would have stopped, through its launcher', () => {
        expect(() => launches.stopLaunch('larder', 'abc')).toThrow('No session started for launch abc')
        session = {started: {launch: 'abc', tmux: 'orrery-larder-abc', stopsAt: '2999-01-01T10:00:00.000Z'}}
        launches.stopLaunch('larder', 'abc')
        expect(launches.extendLaunchBy('larder', 'abc', 30).started!.stopsAt).toBe('2999-01-01T10:30:00.000Z')
        expect(sent).toEqual([{type: 'stop', project: 'larder', id: 'abc'}, {type: 'extend', project: 'larder', id: 'abc', stopsAt: '2999-01-01T10:30:00.000Z'}])
    })
})
