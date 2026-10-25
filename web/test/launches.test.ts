import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal, Starts} from '#shared/roadmap'

// The launches live in the module, so each test gets a fresh one, with Nitro's auto-imports stubbed.
let launches: typeof import('../server/utils/launches')
let asked: {project: string, after: number, minutes: number}[]
let listeners: number
let started: {larder: number, all: number}
let starts: Starts | undefined
let sessionLimit: number

beforeEach(async () => {
    asked = []
    listeners = 0
    started = {larder: 0, all: 0}
    starts = {limit: 2, minutes: 30}
    sessionLimit = 3
    const events = new EventEmitter()
    events.on('launch', launch => asked.push({project: launch.project, after: launch.after, minutes: launch.minutes}))
    vi.stubGlobal('projectEvents', events)
    vi.stubGlobal('listening', () => listeners)
    vi.stubGlobal('startedSessions', (project?: string) => project ? started.larder : started.all)
    vi.stubGlobal('useStore', () => ({project: async () => ({starts}), settings: async () => ({sessionLimit})}))
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
        expect(await launches.considerLaunch(signal(6, {deliveredTo: ['larder 1']}))).toBeNull()
        listeners = 1
        expect(await launches.considerLaunch(signal(6))).toBeNull()
        listeners = 0
        const launch = await launches.considerLaunch(signal(7))
        expect(asked).toEqual([{project: 'larder', after: 6, minutes: 30}])
        // The launch on its way covers what comes after it, until its session connects.
        expect(await launches.considerLaunch(signal(8))).toBeNull()
        expect(launches.launchState('larder')).toEqual({launchers: 1, started: 0, starting: 1})
        launches.launched(launch!.id)
        started = {larder: 1, all: 1}
        expect(await launches.considerLaunch(signal(9))).not.toBeNull()
        done()
        expect(launches.launchState('larder').launchers).toBe(0)
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
    })

    it("lets a launch go whose session never connects", async () => {
        vi.useFakeTimers({now: new Date('2026-10-25T10:00:00Z')})
        launches.addLauncher('larder')
        expect(await launches.considerLaunch(signal(1))).not.toBeNull()
        expect(await launches.considerLaunch(signal(2))).toBeNull()
        vi.setSystemTime(new Date('2026-10-25T10:03:01Z'))
        expect(await launches.considerLaunch(signal(3))).not.toBeNull()
    })
})
