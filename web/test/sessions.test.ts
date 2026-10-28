import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {SESSION_NAMES} from '#shared/roadmap'

// The sessions live in the module, so each test gets a fresh one; `projectEvents` is a Nitro auto-import.
let sessions: typeof import('../server/utils/sessions')
let changed: string[]
let renamed: string[]

beforeEach(async () => {
    changed = []
    const events = new EventEmitter()
    events.on('sessions', project => changed.push(project))
    vi.stubGlobal('projectEvents', events)
    renamed = []
    vi.stubGlobal('useStore', () => ({workedBy: async () => {}, renameSession: async (project: string, from: string, to: string) => renamed.push(`${project}:${from}>${to}`)}))
    vi.stubGlobal('launchTarget', (launch: string) => `launch-${launch}`)
    vi.resetModules()
    // Names start at the top of their order here, not somewhere new as when orrery starts.
    vi.doMock('node:crypto', async original => ({...await original<typeof import('node:crypto')>(), randomInt: () => 0}))
    sessions = await import('../server/utils/sessions')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('a session', () => {
    it('takes the Norse names in a scattered order, every one once, then on with II', () => {
        expect(sessions.NAME_ORDER.slice(0, 4)).toEqual(['Odin', 'Njord', 'Brokk', 'Idun'])
        expect([...sessions.NAME_ORDER].sort()).toEqual([...SESSION_NAMES].sort())
        for (let i = 0; i < SESSION_NAMES.length; i++) sessions.report({id: `n${i}`, project: 'pantry', event: 'SessionStart'})
        expect(sessions.listSessions('pantry').map(s => s.name).slice(0, 3)).toEqual(['pantry · Odin', 'pantry · Njord', 'pantry · Brokk'])
        expect(sessions.report({id: 'over', project: 'pantry', event: 'SessionStart'})?.name).toBe('pantry · Odin II')
        sessions.report({id: 'n2', project: 'pantry', event: 'SessionEnd'})
        expect(sessions.report({id: 'again', project: 'pantry', event: 'SessionStart'})?.name).toBe('pantry · Brokk')
    })

    it('is named after its project, the names taken in turn rather than the first free again', () => {
        expect(sessions.report({id: 'a', project: 'greenhouse', event: 'SessionStart'})?.name).toBe('greenhouse · Odin')
        expect(sessions.report({id: 'b', project: 'greenhouse', event: 'SessionStart'})?.name).toBe('greenhouse · Njord')
        sessions.report({id: 'a', project: 'greenhouse', event: 'SessionEnd'})
        expect(sessions.report({id: 'c', project: 'greenhouse', event: 'SessionStart'})?.name).toBe('greenhouse · Brokk')
        expect(sessions.report({id: 'd', project: 'greenhouse', name: 'pantry', event: 'SessionStart'})?.name).toBe('pantry')
        expect(changed.every(p => p === 'greenhouse')).toBe(true)
    })

    it('hearing several projects, goes by a bare name no session has, and gets its prefix back on one', () => {
        sessions.report({id: 'solo', project: 'hub', event: 'SessionStart'})
        const hub = sessions.attend('hub', 'span', undefined, undefined)
        expect(sessions.sessionName('span')).toBe('hub · Njord')
        const css = sessions.attend('css', 'span', undefined, undefined)
        expect(sessions.sessionName('span')).toBe('Brokk')
        expect(sessions.listSessions('css')).toMatchObject([{id: 'span', name: 'Brokk', also: ['css']}])
        // Its bare name is taken across every project, whatever they hear.
        sessions.attend('pos', 'other', undefined, undefined)
        sessions.attend('css', 'other', undefined, undefined)
        expect(sessions.sessionName('other')).toBe('Tjatse')
        // A skipped channel isn't heard, so doesn't count.
        sessions.attend('docs', 'quiet', undefined, undefined)
        sessions.attend('pos', 'quiet', undefined, undefined, false)
        expect(sessions.sessionName('quiet')).toBe('docs · Sudre')
        css.done()
        expect(sessions.sessionName('span')).toBe('hub · Saga')
        hub.done()
        // A name it was given stays, however many it hears.
        sessions.attend('hub', 'given', undefined, 'maintenance')
        sessions.attend('css', 'given', undefined, 'maintenance')
        expect(sessions.sessionName('given')).toBe('maintenance')
    })

    it('follows its hooks: working, idle, and waiting when asked for a permission', () => {
        const state = (event: string, message?: string) => sessions.report({id: 'a', project: 'greenhouse', event, message})?.state
        expect(state('SessionStart')).toBe('idle')
        expect(state('UserPromptSubmit')).toBe('working')
        expect(state('Notification', 'Claude needs your permission to use Bash')).toBe('waiting')
        expect(state('Notification', 'Claude is waiting for your input')).toBe('idle')
        expect(state('Stop')).toBe('idle')
        expect(state('starting')).toBe('starting')
        expect(state('SessionEnd')).toBeUndefined()
        expect(sessions.listSessions('greenhouse')).toEqual([])
    })

    it('keeps the time its state began until the state changes', () => {
        vi.useFakeTimers({now: new Date('2026-10-25T10:00:00Z')})
        const first = sessions.report({id: 'a', project: 'greenhouse', event: 'UserPromptSubmit'})!
        vi.setSystemTime(new Date('2026-10-25T10:01:00Z'))
        expect(sessions.report({id: 'a', project: 'greenhouse', event: 'PreToolUse'})!.since).toBe(first.since)
        expect(sessions.report({id: 'a', project: 'greenhouse', event: 'Stop'})!.since).toBe('2026-10-25T10:01:00.000Z')
    })

    it('keeps when its hooks last said it went idle, for a repeat to wait on', () => {
        vi.useFakeTimers({now: new Date('2026-10-25T10:00:00Z')})
        sessions.attend('greenhouse', 'a', undefined, undefined)
        expect(sessions.idleAt('a')).toBeUndefined()
        sessions.report({id: 'a', project: 'greenhouse', event: 'Stop'})
        expect(sessions.idleAt('a')).toBe(Date.parse('2026-10-25T10:00:00Z'))
        vi.setSystemTime(new Date('2026-10-25T10:05:00Z'))
        sessions.report({id: 'a', project: 'greenhouse', event: 'working'})
        expect(sessions.idleAt('a')).toBe(Date.parse('2026-10-25T10:00:00Z'))
        expect(sessions.listSessions('greenhouse')[0]).not.toHaveProperty('idleAt')
    })

    it('first heard of by its pid takes its id when a hook brings it, and keeps no pid in public', () => {
        expect(sessions.report({pid: 42, project: 'greenhouse', event: 'SessionStart'})?.id).toBe('pid-42')
        const now = sessions.report({id: 'abc', pid: 42, project: 'greenhouse', cwd: '/repo', event: 'UserPromptSubmit'})!
        expect(now).toMatchObject({id: 'abc', name: 'greenhouse · Odin', cwd: '/repo', state: 'working'})
        expect(now).not.toHaveProperty('pid')
        expect(sessions.listSessions().map(s => s.id)).toEqual(['abc'])
        expect(sessions.sessionName('abc')).toBe('greenhouse · Odin')
        expect(sessions.sessionName(undefined)).toBeUndefined()
    })

    it('listens while its channel is connected', () => {
        const {id, done} = sessions.attend('greenhouse', 'a', undefined, 'pantry')
        expect(sessions.listSessions('greenhouse')).toMatchObject([{id, name: 'pantry', listening: true}])
        done()
        expect(sessions.listSessions('greenhouse')[0]!.listening).toBe(false)
        // A session started without the channel flag connects but wouldn't hear.
        expect(sessions.attend('greenhouse', 'b', undefined, undefined, false)).toMatchObject({id: 'b'})
        expect(sessions.listSessions('greenhouse').find(s => s.id === 'b')).toMatchObject({name: 'greenhouse · Odin', listening: false})
    })

    it('takes the focus made for its launch as its own', () => {
        const {id} = sessions.attend('greenhouse', 'a', undefined, undefined, true, undefined, false, 'l9')
        expect(sessions.currentId('launch-l9')).toBe(id)
        expect(sessions.sessionIds(id)).toContain('launch-l9')
        expect(sessions.currentId('launch-l8')).toBe('launch-l8')
    })

    it("started for the owner's chat, holds no place among those orrery started", () => {
        sessions.attend('greenhouse', 'chat', undefined, undefined, true, {launch: 'c1', tmux: 'orrery-greenhouse-c1', chat: true})
        expect(sessions.chatSession('chat')).toBe(true)
        expect([sessions.startedSessions('greenhouse'), sessions.startedSessions()]).toEqual([0, 0])
    })

    it('started by orrery says which launch, and counts as one it started while its channel is there', () => {
        const launch = (id: string) => ({launch: id, tmux: `orrery-greenhouse-${id}`, stops_at: '2026-10-25T11:00:00.000Z'})
        const a = sessions.attend('greenhouse', 'a', undefined, undefined, true, launch('l1'))
        sessions.attend('greenhouse', 'b', undefined, undefined)
        sessions.attend('mesa', 'c', undefined, undefined, true, launch('l3'))
        expect(sessions.listSessions('greenhouse').map(s => s.started?.launch)).toEqual(['l1', undefined])
        expect([sessions.startedSessions('greenhouse'), sessions.startedSessions()]).toEqual([1, 2])
        // Its channel gone (it crashed, or was killed by hand), it no longer holds a place.
        a.done()
        expect(sessions.startedSessions('greenhouse')).toBe(0)
        expect(sessions.sessionOfLaunch('greenhouse', 'l1')?.id).toBe('a')
        expect(sessions.extendLaunch('greenhouse', 'l1', '2026-10-25T11:30:00.000Z')?.started?.stops_at).toBe('2026-10-25T11:30:00.000Z')
        // Its launcher saying it ended drops it, by its launch.
        sessions.launchEnded('greenhouse', 'l1')
        sessions.launchEnded('greenhouse', 'l3')
        expect(sessions.listSessions().map(s => s.id)).toEqual(['b', 'c'])
        expect(sessions.extendLaunch('greenhouse', 'l1', '2026-10-25T12:00:00.000Z')).toBeUndefined()
    })

    it("listens on its project's channel only, whatever the window's other channels say", () => {
        sessions.report({id: 'w', project: 'docs', event: 'SessionStart'})
        const docs = sessions.attend('docs', 'w', undefined, undefined)
        const hub = sessions.attend('hub', 'w', undefined, undefined, false)
        sessions.attend('pos', 'w', undefined, undefined, false).done()
        expect(sessions.listSessions('docs')).toMatchObject([{id: 'w', listening: true}])
        expect(sessions.hearing('docs', 'w')).toBe(true)
        hub.done()
        expect(sessions.hearing('docs', 'w')).toBe(true)
        docs.done()
        docs.done()
        expect(sessions.hearing('docs', 'w')).toBe(false)
    })

    it('heard on several projects by one channel, keeps its own and shows on each', () => {
        sessions.report({id: 'w', project: 'hub', event: 'SessionStart'})
        sessions.attend('hub', 'w', undefined, undefined)
        const pos = sessions.attend('pos', 'w', undefined, undefined)
        expect(sessions.listSessions('pos')).toMatchObject([{id: 'w', project: 'hub', listening: true, also: ['pos']}])
        expect(sessions.listSessions('hub')).toHaveLength(1)
        expect([sessions.hearing('hub', 'w'), sessions.hearing('pos', 'w'), sessions.hearing('css', 'w')]).toEqual([true, true, false])
        pos.done()
        expect(sessions.listSessions('pos')).toEqual([])
    })

    it("keeps its hooks' project as its own, whichever of its channels connects first", () => {
        sessions.report({id: 'w', project: 'hub', event: 'SessionStart'})
        sessions.attend('pos', 'w', undefined, undefined)
        sessions.attend('hub', 'w', undefined, undefined)
        expect(sessions.listSessions('hub')).toMatchObject([{id: 'w', project: 'hub', listening: true, also: ['pos']}])
    })

    it('heard on several projects before its hook speaks, takes the one the hook names', () => {
        sessions.attend('pos', 'w', undefined, undefined)
        sessions.attend('hub', 'w', undefined, undefined)
        expect(sessions.listSessions('pos')).toMatchObject([{project: 'pos'}])
        sessions.report({id: 'w', project: 'hub', event: 'SessionStart'})
        expect(sessions.listSessions('hub')).toMatchObject([{id: 'w', project: 'hub', listening: true, also: ['pos']}])
        // A hook naming a project none of its channels hears leaves it where it's heard.
        sessions.report({id: 'w', project: 'css', event: 'Stop'})
        expect(sessions.listSessions('hub')).toMatchObject([{project: 'hub'}])
    })

    it('started for a project by orrery, is on it, and counts toward its limit only', () => {
        sessions.attend('hub', 'w', undefined, undefined)
        sessions.attend('pos', 'w', undefined, undefined, true, {launch: 'l1', tmux: 't', stops_at: '2999-01-01T00:00:00.000Z'})
        expect(sessions.listSessions('pos')[0]).toMatchObject({project: 'pos', also: ['hub']})
        expect([sessions.startedSessions('pos'), sessions.startedSessions('hub')]).toEqual([1, 0])
    })

    it('stays listening while a reconnect overlaps the stream it replaces', () => {
        const before = sessions.attend('docs', 'w', undefined, undefined)
        const after = sessions.attend('docs', 'w', undefined, undefined)
        before.done()
        before.done()
        expect(sessions.hearing('docs', 'w')).toBe(true)
        after.done()
        expect(sessions.hearing('docs', 'w')).toBe(false)
    })

    it("moves to the heard channel's project when a skipped one connected first", () => {
        sessions.attend('hub', 'w', undefined, undefined, false)
        expect(sessions.listSessions('hub')).toMatchObject([{id: 'w', name: 'hub · Odin', listening: false}])
        sessions.attend('docs', 'w', undefined, undefined)
        expect(sessions.listSessions('hub')).toEqual([])
        expect(sessions.listSessions('docs')).toMatchObject([{id: 'w', name: 'docs · Njord', listening: true}])
    })

    it("can be stopped only through its own project's channel, which hears the stop", () => {
        sessions.attend('docs', 'w', 42, undefined, true, undefined, true)
        const hub = sessions.attend('hub', 'w', 42, undefined, false, undefined, true)
        expect(sessions.listSessions('docs')).toMatchObject([{reachable: true}])
        sessions.attend('docs', 'w', 42, undefined, true).done()
        hub.done()
        expect(sessions.listSessions('docs')).toMatchObject([{reachable: true, listening: true}])
        const old = sessions.attend('pos', 'v', 7, undefined, true)
        sessions.attend('docs', 'v', 7, undefined, false, undefined, true)
        // Its skipped docs channel can't stop it: the stop goes out on its own project's stream.
        expect(sessions.listSessions('pos')).toMatchObject([{id: 'v', reachable: false, listening: true}])
        old.done()
    })

    it('outlives a /clear: the new id takes it over by its pid, and the old one stays an alias', () => {
        const channel = sessions.attend('greenhouse', 'before', 42, undefined)
        sessions.report({id: 'before', pid: 42, project: 'greenhouse', event: 'SessionEnd', reason: 'clear'})
        expect(sessions.listSessions('greenhouse')).toMatchObject([{id: 'before', name: 'greenhouse · Odin', listening: true, state: 'idle'}])
        sessions.report({id: 'after', pid: 42, project: 'greenhouse', event: 'SessionStart'})
        expect(sessions.listSessions('greenhouse')).toMatchObject([{id: 'after', name: 'greenhouse · Odin', listening: true}])
        // The channel, connected before, now goes by the new id; its old one still finds the session.
        expect(channel.id).toBe('after')
        expect([sessions.currentId('before'), sessions.currentId('other')]).toEqual(['after', 'other'])
        expect([sessions.hearing('greenhouse', 'before'), sessions.sessionName('before')]).toEqual([true, 'greenhouse · Odin'])
        // Its channel goes on reporting with the old id, which doesn't take the session back to it.
        sessions.report({id: 'before', project: 'greenhouse', event: 'working'})
        expect(sessions.listSessions('greenhouse')).toMatchObject([{id: 'after', state: 'working'}])
        // A second clear: every id it has had leads to the newest.
        sessions.report({id: 'after', pid: 42, project: 'greenhouse', event: 'SessionEnd', reason: 'clear'})
        sessions.report({id: 'latest', pid: 42, project: 'greenhouse', event: 'SessionStart'})
        expect(sessions.sessionIds('before')).toEqual(['latest', 'before', 'after'])
        // Quitting ends it, aliases and all.
        sessions.report({id: 'latest', project: 'greenhouse', event: 'SessionEnd', reason: 'prompt_input_exit'})
        expect(sessions.listSessions('greenhouse')).toEqual([])
        expect(sessions.currentId('before')).toBe('before')
        // A clear of a session orrery never heard of starts nothing.
        expect(sessions.report({id: 'stranger', project: 'greenhouse', event: 'SessionEnd', reason: 'clear'})).toBeNull()
    })

    it('moves what its old id worked and was sent to the new one, so a restart loses none of it', () => {
        sessions.report({id: 'before', pid: 42, project: 'greenhouse', event: 'SessionStart'})
        sessions.report({id: 'before', pid: 42, project: 'greenhouse', event: 'SessionEnd', reason: 'clear'})
        sessions.report({id: 'after', pid: 42, project: 'greenhouse', event: 'SessionStart', source: 'clear'})
        sessions.report({id: 'before', pid: 42, project: 'greenhouse', event: 'working'})
        expect(renamed).toEqual(['greenhouse:before>after'])
    })

    it('resumed by its old id in another window is another session', () => {
        const channel = sessions.attend('greenhouse', 'before', 42, undefined)
        sessions.report({id: 'before', pid: 42, project: 'greenhouse', event: 'SessionEnd', reason: 'clear'})
        sessions.report({id: 'after', pid: 42, project: 'greenhouse', event: 'SessionStart', source: 'clear'})
        // `claude --resume before` in another terminal.
        sessions.report({id: 'before', pid: 99, project: 'greenhouse', event: 'SessionStart', source: 'resume'})
        expect(sessions.listSessions('greenhouse')).toMatchObject([{id: 'after', name: 'greenhouse · Odin', listening: true}, {id: 'before', name: 'greenhouse · Njord', listening: false}])
        expect(sessions.currentId('before')).toBe('before')
        // The first window's channel, still on the old id, reaches its own session by its pid.
        sessions.attend('greenhouse', 'before', 42, undefined).done()
        expect(channel.id).toBe('after')
        sessions.report({id: 'before', pid: 42, project: 'greenhouse', event: 'working'})
        expect(sessions.listSessions('greenhouse')).toMatchObject([{id: 'after', state: 'working'}, {id: 'before', state: 'idle'}])
    })

    it('outlives a /clear with no pid: the next session after a clear in its folder takes it over', () => {
        vi.useFakeTimers()
        sessions.attend('greenhouse', 'before', undefined, undefined)
        sessions.report({id: 'before', project: 'greenhouse', cwd: '/src/greenhouse', event: 'SessionStart'})
        sessions.report({id: 'before', project: 'greenhouse', cwd: '/src/greenhouse', event: 'SessionEnd', reason: 'clear'})
        // A fresh window, or a clear in another folder, isn't it.
        sessions.report({id: 'fresh', project: 'greenhouse', cwd: '/src/greenhouse', event: 'SessionStart', source: 'startup'})
        sessions.report({id: 'elsewhere', project: 'greenhouse', cwd: '/src/other', event: 'SessionStart', source: 'clear'})
        sessions.report({id: 'after', project: 'greenhouse', cwd: '/src/greenhouse', event: 'SessionStart', source: 'clear'})
        expect(sessions.listSessions('greenhouse').map(s => s.id).sort()).toEqual(['after', 'elsewhere', 'fresh'])
        expect([sessions.currentId('before'), sessions.hearing('greenhouse', 'after')]).toEqual(['after', true])
        // It waits a minute at most: a clear after that is a session of its own.
        sessions.report({id: 'fresh', project: 'greenhouse', cwd: '/src/greenhouse', event: 'SessionEnd', reason: 'clear'})
        vi.advanceTimersByTime(61_000)
        sessions.report({id: 'late', project: 'greenhouse', cwd: '/src/greenhouse', event: 'SessionStart', source: 'clear'})
        expect(sessions.listSessions('greenhouse').map(s => s.id).sort()).toEqual(['after', 'elsewhere', 'fresh', 'late'])
    })

    it("its channel says is untrusted stays so, though orrery doesn't know its launch and the launcher's report leaves it out", () => {
        sessions.attend('greenhouse', 'locked', undefined, undefined, true, undefined, true, 'l9', undefined, true)
        sessions.attend('greenhouse', 'plain', undefined, undefined, true, undefined, true, 'l8')
        expect([sessions.untrustedSession('locked'), sessions.untrustedSession('plain')]).toEqual([true, false])
        sessions.adoptLaunch('greenhouse', {launch: 'l9', tmux: 'orrery-greenhouse-9'})
        expect(sessions.untrustedSession('locked')).toBe(true)
    })

    it('started by orrery keeps its launch across a /clear', () => {
        sessions.attend('greenhouse', 'before', 42, undefined, true, {launch: 'l1', tmux: 'orrery-greenhouse-l1', stops_at: '2026-10-25T11:00:00.000Z'})
        sessions.report({id: 'before', pid: 42, project: 'greenhouse', event: 'SessionEnd', reason: 'clear'})
        sessions.report({id: 'after', pid: 42, project: 'greenhouse', event: 'SessionStart'})
        expect(sessions.sessionOfLaunch('greenhouse', 'l1')?.id).toBe('after')
        expect(sessions.startedSessions('greenhouse')).toBe(1)
        expect(sessions.extendLaunch('greenhouse', 'l1', '2026-10-25T11:30:00.000Z')?.started?.stops_at).toBe('2026-10-25T11:30:00.000Z')
        sessions.launchEnded('greenhouse', 'l1')
        expect([sessions.listSessions('greenhouse'), sessions.currentId('before')]).toEqual([[], 'before'])
    })

    it('is forgotten after six quiet hours, unless it is listening', () => {
        vi.useFakeTimers({now: new Date('2026-10-25T10:00:00Z')})
        sessions.report({id: 'quiet', project: 'greenhouse', event: 'Stop'})
        sessions.attend('greenhouse', 'listening', undefined, undefined)
        sessions.report({id: 'other', project: 'mesa', event: 'Stop'})
        expect(sessions.listSessions('greenhouse').map(s => s.id)).toEqual(['quiet', 'listening'])
        vi.setSystemTime(new Date('2026-10-25T16:00:01Z'))
        expect(sessions.listSessions().map(s => s.id)).toEqual(['listening'])
    })
})

describe('listeners', () => {
    it('are counted per project, each once however often it says it is done', async () => {
        const {listen, listening, projectEvents} = await import('../server/utils/events')
        const heard: string[] = []
        projectEvents.on('listeners', project => heard.push(project))
        const one = listen('greenhouse')
        const two = listen('greenhouse')
        expect([listening('greenhouse'), listening('mesa')]).toEqual([2, 0])
        one()
        one()
        expect(listening('greenhouse')).toBe(1)
        two()
        expect(listening('greenhouse')).toBe(0)
        expect(heard).toEqual(['greenhouse', 'greenhouse', 'greenhouse', 'greenhouse'])
    })
})

describe('the issues a session writes to', () => {
    it('are the ones its curls send a body or a PATCH, POST or PUT to', () => {
        const writes = (command: string) => sessions.issueWrites(command, 'greenhouse').map(w => `${w.project}/${w.issue}`)
        expect(writes(`curl -s -X PATCH http://localhost:9000/api/projects/greenhouse/issues/GRE-12 -d '{"status":"done"}'`)).toEqual(['greenhouse/GRE-12'])
        expect(writes(`curl -s -X POST $ISSUES/GRE-3/comments -H "$H" --data @reply.json && curl -s $ISSUES/GRE-4`)).toEqual(['greenhouse/GRE-3'])
        expect(writes(`curl -X PUT http://x/api/projects/pantry/issues/PAN-1 -d '{}'`)).toEqual(['pantry/PAN-1'])
        expect(writes('curl -s http://localhost:9000/api/projects/greenhouse/issues/GRE-12')).toEqual([])
        expect(writes('git commit -m "fix GRE-12" -d')).toEqual([])
        expect(writes(`curl -X DELETE $ISSUES/GRE-9`)).toEqual([])
    })

    it("note the session as the issue's worker, from its hook", async () => {
        const worked: string[] = []
        vi.stubGlobal('useStore', () => ({workedBy: async (project: string, issue: string, session: string) => worked.push(`${project}/${issue}:${session}`)}))
        sessions.report({id: 'a', project: 'greenhouse', event: 'PreToolUse', command: `curl -X PATCH $ISSUES/GRE-7 -d '{"status":"in-progress"}'`})
        sessions.report({id: 'b', project: 'greenhouse', event: 'PreToolUse', command: 'ls'})
        await Promise.resolve()
        expect(worked).toEqual(['greenhouse/GRE-7:a'])
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
        expect(() => sessions.stopSession('greenhouse', 'a')).toThrow('No session a in greenhouse')
        sessions.report({id: 'a', project: 'greenhouse', event: 'SessionStart'})
        expect(() => sessions.stopSession('greenhouse', 'a')).toThrow('has no orrery channel running')
        expect(sessions.listSessions('greenhouse')[0]!.reachable).toBe(false)
        // An older channel doesn't know to quit; one without the flag can't hear signals, but can still be stopped.
        const old = sessions.attend('greenhouse', 'a', undefined, undefined, true)
        expect(() => sessions.stopSession('greenhouse', 'a')).toThrow('an older channel needs the session restarted')
        old.done()
        const first = sessions.attend('greenhouse', 'a', undefined, undefined, false, undefined, true)
        const second = sessions.attend('greenhouse', 'a', undefined, undefined, false, undefined, true)
        expect(sessions.listSessions('greenhouse')[0]!.reachable).toBe(true)
        expect(() => sessions.stopSession('mesa', 'a')).toThrow('No session a in mesa')
        expect(sessions.stopSession('greenhouse', 'a').name).toBe('greenhouse · Odin')
        expect(asked).toEqual([{project: 'greenhouse', id: 'a'}])
        // An id it had before a /clear still reaches it.
        sessions.report({id: 'a', pid: 7, project: 'greenhouse', event: 'SessionEnd', reason: 'clear'})
        sessions.report({id: 'a2', pid: 7, project: 'greenhouse', event: 'SessionStart'})
        sessions.stopSession('greenhouse', 'a')
        expect(asked).toEqual([{project: 'greenhouse', id: 'a'}, {project: 'greenhouse', id: 'a2'}])
        first.done()
        expect(sessions.listSessions('greenhouse')).toHaveLength(1)
        second.done()
        expect(sessions.listSessions('greenhouse')).toEqual([])
    })

    it("goes through the launcher for one orrery started", () => {
        vi.stubGlobal('stopLaunch', (project: string, launch: string) => ({project, launch}))
        vi.stubGlobal('launchersOf', () => 1)
        sessions.attend('greenhouse', 'b', undefined, undefined, true, {launch: 'abc', tmux: 'orrery-greenhouse-abc', stops_at: '2999-01-01T00:00:00.000Z'})
        expect(sessions.stopSession('greenhouse', 'b')).toEqual({project: 'greenhouse', launch: 'abc'})
    })

    it("goes through its channel for one orrery started when no launcher is there to stop it", () => {
        const asked: unknown[] = []
        projectEvents.on('session-stop', event => asked.push(event))
        vi.stubGlobal('stopLaunch', () => {
            throw new Error('not through the launcher')
        })
        vi.stubGlobal('launchersOf', () => 0)
        sessions.attend('greenhouse', 'b', undefined, undefined, true, {launch: 'abc', tmux: 'orrery-greenhouse-abc', stops_at: '2999-01-01T00:00:00.000Z'}, true)
        expect(sessions.stopSession('greenhouse', 'b').name).toBe('greenhouse · Odin')
        expect(asked).toEqual([{project: 'greenhouse', id: 'b'}])
    })
})

describe('a session orrery started, after orrery restarts', () => {
    it("counts as started again once its launcher reports the launch, though its channel connected first", () => {
        const started = {launch: 'a1b2c3d4e5f6', tmux: 'orrery-greenhouse-a1b2c3d4e5f6', stops_at: '2999-01-01T00:00:00.000Z'}
        // orrery doesn't know the launch yet, so the channel connects as an ordinary session, saying its launch.
        sessions.attend('greenhouse', 'b', undefined, undefined, true, undefined, true, started.launch)
        expect(sessions.startedSessions('greenhouse')).toBe(0)
        sessions.adoptLaunch('greenhouse', started)
        expect(sessions.startedSessions('greenhouse')).toBe(1)
        expect(sessions.sessionOfLaunch('greenhouse', started.launch)?.started).toEqual(started)
        // Another project's report of the same id doesn't touch it.
        sessions.adoptLaunch('mesa', {...started, stops_at: '2000-01-01T00:00:00.000Z'})
        expect(sessions.sessionOfLaunch('greenhouse', started.launch)?.started?.stops_at).toBe(started.stops_at)
    })
})

describe('a message to every session', () => {
    it('reaches each listening one once, idle by default, narrowed by project', () => {
        sessions.report({id: 'a', project: 'greenhouse', event: 'SessionStart'})
        sessions.attend('greenhouse', 'a', undefined, undefined)
        // One session hearing two projects is one recipient.
        sessions.attend('pantry', 'a', undefined, undefined)
        sessions.report({id: 'b', project: 'pantry', event: 'SessionStart'})
        sessions.attend('pantry', 'b', undefined, undefined)
        sessions.report({id: 'b', project: 'pantry', event: 'UserPromptSubmit'})
        // Not listening: its channel can't hear it.
        sessions.report({id: 'c', project: 'greenhouse', event: 'SessionStart'})
        const ids = (projects?: string[], states?: Parameters<typeof sessions.recipients>[1]) => sessions.recipients(projects, states).map(s => s.id)
        expect(ids()).toEqual(['a'])
        expect(ids(undefined, ['idle', 'working'])).toEqual(['a', 'b'])
        expect(ids(['pantry'], ['idle', 'working'])).toEqual(['a', 'b'])
        expect(ids(['greenhouse'], ['idle', 'working'])).toEqual(['a'])
        expect(ids(['mesa'])).toEqual([])
    })
})

describe("a session's stream", () => {
    it('tells it its name once known, and again only when it changes', async () => {
        vi.stubGlobal('sessionName', sessions.sessionName)
        const {sayName} = await import('../server/utils/signal-feed')
        const pushed: string[] = []
        const stop = sayName({push: ({event, data}) => pushed.push(`${event} ${JSON.parse(data).name}`)}, () => 'a')
        expect(pushed).toEqual([])
        sessions.report({id: 'a', project: 'greenhouse', event: 'SessionStart'})
        sessions.report({id: 'a', project: 'greenhouse', event: 'UserPromptSubmit'})
        sessions.report({id: 'a', project: 'greenhouse', name: 'pantry', event: 'SessionStart'})
        stop()
        sessions.report({id: 'a', project: 'greenhouse', name: 'cellar', event: 'SessionStart'})
        expect(pushed).toEqual(['name greenhouse · Odin', 'name pantry'])
    })
})

describe("a session's channel in the event log", () => {
    it('says who connected to the feed for which projects, and left', async () => {
        const {channelEntry} = await import('../server/utils/signal-feed')
        const who = {name: 'greenhouse · Odin', heard: true, stops: true, untrusted: false, chat: false}
        expect(channelEntry('connected', ['greenhouse'], false, who, 's-1')).toEqual({
            level: 'info', kind: 'channel.connected', project: 'greenhouse',
            message: 'greenhouse · Odin connected to the feed for greenhouse', details: {session: 's-1', projects: ['greenhouse'], heard: true},
        })
        expect(channelEntry('left', ['greenhouse', 'pantry'], true, {...who, name: undefined, untrusted: true}, 's-1', 'Frøya')).toEqual({
            level: 'info', kind: 'channel.left',
            message: 'Frøya left the feed for every project', details: {session: 's-1', projects: ['*'], heard: true, untrusted: true},
        })
        expect(channelEntry('connected', ['pantry'], false, {...who, name: undefined, heard: false, pid: 42}).message)
            .toBe("pid 42 connected to the feed for pantry (not started with the channel flag: it won't hear)")
    })
})
