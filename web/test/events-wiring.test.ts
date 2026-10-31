import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// How events.ts wires the store's helpers to the page's events (ORR-585): each is made once, the secrets, the pull
// poll and the event log say what changed as events, a token or setting changing makes them read again, a schedule's
// run goes to the event log as the right kind, the database moving reaches what holds it, and the routes' small
// helpers. The classes are stood in for, keeping what they were made with; Nitro's auto-imports are stubbed.
type Made = Record<string, unknown[]>
let made: Made
let calls: string[]
let db: {afterCommit: (done: () => void) => void}
let events: typeof import('../server/utils/events')

const fake = (name: string, more: Record<string, unknown> = {}) => class {
    db: unknown = 'old'
    constructor(...args: unknown[]) {
        made[name] = args
        Object.assign(this, more)
    }
}

beforeEach(async () => {
    made = {}
    calls = []
    db = {afterCommit: done => done()}
    vi.stubGlobal('useDatabase', () => db)
    vi.stubGlobal('useRuntimeConfig', () => ({secretKey: 'k'}))
    vi.stubGlobal('hearing', () => false)
    vi.stubGlobal('startUntrusted', () => {})
    vi.stubGlobal('startLaunch', async (project: string, at: object) => ({project, ...at}))
    vi.stubGlobal('contextFor', async (_project: string, presets: string[]) => `context ${presets.join(',')}`)
    vi.stubGlobal('getRouterParam', (event: {params: Record<string, string>}, name: string) => event.params[name])
    vi.stubGlobal('setResponseStatus', (event: {status?: number}, status: number) => void (event.status = status))
    vi.stubGlobal('notFound', (message: string) => Object.assign(new Error(message), {statusCode: 404}))
    vi.resetModules()
    vi.doMock('../server/utils/store', () => ({Store: fake('Store', {seedPresets: async () => void calls.push('seedPresets'), settings: async () => ({uid: 'x7k2m9qd'})})}))
    vi.doMock('../server/utils/secrets', () => ({Secrets: fake('Secrets', {scrubber: () => 'scrub', own: () => 'own', ownsFor: () => true})}))
    vi.doMock('../server/utils/pulls', () => ({GITHUB_SECRET: 'GITHUB_TOKEN', Pulls: fake('Pulls')}))
    vi.doMock('../server/utils/branches', () => ({Branches: fake('Branches')}))
    vi.doMock('../server/utils/pull-poll', () => ({PullPoll: fake('PullPoll', {secretsChanged: () => calls.push('poll.secretsChanged')})}))
    vi.doMock('../server/utils/pull-comments', () => ({commentOnPull: async (_store: unknown, change: {pr: number}) => void calls.push(`commentOnPull ${change.pr}`)}))
    vi.doMock('../server/utils/event-log', () => ({EventLog: fake('EventLog', {forget: () => calls.push('log.forget'), note: (entry: object) => calls.push(`note ${JSON.stringify(entry)}`)})}))
    vi.doMock('../server/utils/schedules', () => ({Schedules: fake('Schedules'), scheduleRunning: {getStore: () => undefined}}))
    events = await import('../server/utils/events')
})

afterEach(() => {
    vi.unstubAllGlobals()
    for (const m of ['store', 'secrets', 'pulls', 'branches', 'pull-poll', 'pull-comments', 'event-log', 'schedules']) vi.doUnmock(`../server/utils/${m}`)
})

const heard = (event: string) => {
    const got: unknown[] = []
    events.projectEvents.on(event, value => got.push(value))
    return got
}

describe("events.ts's helpers", () => {
    it('makes each once', () => {
        for (const use of [events.useStore, events.useSecrets, events.usePulls, events.useBranches, events.usePullPoll, events.useEventLog, events.useScheduler]) expect(use()).toBe(use())
    })

    it("sends the secrets' list as `secrets` when they change and as `secret-used` when one is used, sealed with the key", () => {
        events.useSecrets()
        const [, key, onChange] = made.Secrets as [unknown, () => string, (list: unknown, used: boolean) => void]
        expect(key()).toBe('k')
        const changed = heard('secrets')
        const used = heard('secret-used')
        onChange(['A'], false)
        onChange(['B'], true)
        expect([changed, used]).toEqual([[['A']], [['B']]])
    })

    it('sends a pull request change out, says it on its issue, and polls again with a new token', () => {
        events.usePullPoll()
        const [, , owns, onChange] = made.PullPoll as [unknown, unknown, (project: string) => boolean, (change: {pr: number}) => void]
        expect(owns('greenhouse')).toBe(true)
        const changes = heard('pull-change')
        onChange({pr: 7})
        expect(changes).toEqual([{pr: 7}])
        events.projectEvents.emit('secrets', [])
        expect(calls).toEqual(['commentOnPull 7', 'poll.secretsChanged'])
    })

    it("sends what the event log keeps as `logged`, scrubbed of secrets, and reads settings and secrets again as they change", () => {
        events.useEventLog()
        const [, scrubber, onLogged] = made.EventLog as [unknown, () => unknown, (event: unknown, fresh: boolean) => void]
        expect(scrubber()).toBe('scrub')
        const logged = heard('logged')
        onLogged({id: 1}, true)
        expect(logged).toEqual([{event: {id: 1}, fresh: true}])
        events.projectEvents.emit('settings', {})
        events.projectEvents.emit('secrets', [])
        expect(calls.filter(c => c === 'log.forget')).toHaveLength(2)
    })

    it("logs a schedule's run as ran, skipped or failed, and starts a session one asks for with its presets' context", async () => {
        events.useScheduler()
        const [, options] = made.Schedules as [unknown, {onChange: (project: string) => void, onRan: (...args: unknown[]) => void, startSession: (...args: unknown[]) => Promise<unknown>}]
        const changed = heard('schedules')
        options.onChange('greenhouse')
        expect(changed).toEqual(['greenhouse'])
        const schedule = {id: 4, project: 'greenhouse', title: 'Tidy'}
        options.onRan(schedule, {outcome: 'made', issue: 'GRE-9'})
        options.onRan(schedule, {outcome: 'skipped', note: 'nothing changed'}, 'steffen')
        options.onRan(schedule, {outcome: 'failed'})
        const notes = calls.map(c => JSON.parse(c.slice(5)) as {level: string, kind: string, message: string, details: object})
        expect(notes.map(n => [n.level, n.kind, n.message])).toEqual([
            ['info', 'schedule.ran', 'Tidy: made GRE-9'],
            ['info', 'schedule.skipped', 'Tidy: skipped, nothing changed'],
            ['error', 'schedule.failed', 'Tidy: failed'],
        ])
        expect(notes[1]!.details).toEqual({schedule: 4, outcome: 'skipped', note: 'nothing changed', manual: 'steffen'})
        expect(await options.startSession('greenhouse', {presets: ['review'], instructions: '', issue: 'GRE-1'}, 'steffen'))
            .toEqual({project: 'greenhouse', issue: 'GRE-1', release: undefined, context: 'context review', actor: 'steffen'})
    })

    it('points the store and the event log at the database it moved to, and seeds it with the presets', async () => {
        const store = events.useStore() as unknown as {db: unknown}
        const log = events.useEventLog() as unknown as {db: unknown}
        events.rebindDatabase('new' as never)
        expect([store.db, log.db]).toEqual(['new', 'new'])
        await vi.waitFor(() => expect(calls).toContain('seedPresets'))
    })

    it("passes on what happened, and what changed to the event log too, once the write commits", async () => {
        const store = events.useStore() as unknown as {happened: (event: object) => void}
        const log = events.useEventLog() as unknown as {happened: (event: object) => void, activity: (...args: unknown[]) => Promise<void>}
        const activity: unknown[] = []
        log.activity = async (...args) => void activity.push(args)
        let commit: (() => void)[] = []
        db.afterCommit = done => void commit.push(done)
        const happened = heard('happened')
        store.happened({type: 'issue.moved'})
        log.happened({type: 'event.logged'})
        expect(happened).toEqual([])
        commit.forEach(done => done())
        commit = []
        expect(happened).toEqual([{event: {type: 'issue.moved'}, cause: undefined}, {event: {type: 'event.logged'}, cause: undefined}])
        expect(activity).toEqual([[{type: 'issue.moved'}, undefined]])
    })

    it("decodes a route's part, and takes a malformed escape as it is", () => {
        expect(events.param({params: {issue: 'GRE%2D1'}} as never, 'issue')).toBe('GRE-1')
        expect(events.param({params: {}} as never, 'issue')).toBe('')
        expect(events.decoded('ORR-%E0')).toBe('ORR-%E0')
    })

    it("reads a comment's or schedule's id from the route, and 404s one that isn't a number", async () => {
        expect(events.commentId({params: {comment: '12'}} as never)).toBe(12)
        expect(await events.scheduleId({params: {schedule: '3'}} as never)).toBe(3)
        expect(await events.scheduleId({params: {schedule: 'sch-3-x7k2m9qd'}} as never)).toBe(3)
        expect(() => events.commentId({params: {comment: 'x'}} as never)).toThrow('No comment x')
        await expect(events.scheduleId({params: {schedule: '1.5'}} as never)).rejects.toThrow('No schedule 1.5')
        await expect(events.scheduleId({params: {schedule: 'sch-3-aaaaaaaa'}} as never)).rejects.toThrow('No schedule sch-3-aaaaaaaa')
    })

    it('answers a create with 201 and a delete with 204', () => {
        const event = {} as {status?: number}
        expect(events.created(event as never, {id: 1})).toEqual({id: 1})
        expect(event.status).toBe(201)
        expect(events.deleted(event as never)).toBeNull()
        expect(event.status).toBe(204)
    })
})
