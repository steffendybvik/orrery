// Signals: what sessions are told, who hears it, and what each session is on. The store, against a fresh database with
// the project `greenhouse` (store-setup.ts).
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_CHUNK_PROMPT, DEFAULT_FOCUS_PROMPT} from '#shared/prompt'
import {Store} from '../server/utils/store'
import {testDb} from './db'
import type {Actor} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store
let changes: string[]

beforeEach(async () => {
    ({store, changes} = await storeSetup())
})

describe('what sessions are told', () => {
    const owner: Actor = {name: 'skoll', owner: true}

    it("uses the project's templates, else the orrery's, else the defaults", async () => {
        expect(await store.prompts('greenhouse')).toEqual({focus: DEFAULT_FOCUS_PROMPT, chunk: DEFAULT_CHUNK_PROMPT})
        await store.updateSettings({focus_prompt: 'Look at {issue}.'}, owner)
        await store.updateProject('greenhouse', {chunk_prompt: 'Do chunk {chunk}.'}, owner)
        expect(await store.prompts('greenhouse')).toEqual({focus: 'Look at {issue}.', chunk: 'Do chunk {chunk}.'})
        await store.updateProject('greenhouse', {chunk_prompt: '  '}, owner)
        await store.updateSettings({focus_prompt: ''}, owner)
        expect(await store.prompts('greenhouse')).toEqual({focus: DEFAULT_FOCUS_PROMPT, chunk: DEFAULT_CHUNK_PROMPT})
    })

    it("are the owner's to change", async () => {
        expect((await failure(() => store.updateProject('greenhouse', {focus_prompt: 'x'}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await failure(() => store.updateSettings({instructions: []}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await store.updateProject('greenhouse', {description: 'still fine'})).description).toBe('still fine')
    })

    it('add the standing instructions ticked by default, or those picked for the send', async () => {
        const {instructions: [commit, branch]} = await store.updateSettings({instructions: [{text: 'Commit whenever a piece works'}, {text: 'Make a branch', on: false}]}, owner)
        expect([commit!.on, branch!.on, commit!.id]).toEqual([true, false, expect.stringMatching(/^[0-9a-f]{8}$/)])
        const {instructions: [tests]} = await store.updateProject('greenhouse', {instructions: [{text: 'Run the tests'}]}, owner)
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        expect((await store.focus('greenhouse', id, {}, owner)).instructions).toEqual(['Commit whenever a piece works', 'Run the tests'])
        await store.updateProject('greenhouse', {muted: [commit!.id]}, owner)
        expect((await store.focus('greenhouse', id, {}, owner)).instructions).toEqual(['Run the tests'])
        expect((await store.focusChunk('greenhouse', '1', {instructions: [branch!.id, tests!.id]}, owner)).instructions).toEqual(['Make a branch', 'Run the tests'])
        expect((await store.focus('greenhouse', id, {instructions: []}, owner)).instructions).toEqual([])
        expect((await failure(() => store.focus('greenhouse', id, {instructions: ['nope']}, owner))).status).toBe(400)
        expect((await failure(() => store.updateSettings({instructions: [{text: ''}]}, owner))).status).toBe(400)
    })
})
describe('starting sessions', () => {
    const owner = {name: 'skoll', owner: true}

    it("is the owner's to allow once for every project, as {limit, min?, minutes?, idle_minutes?}, and to stop with null", async () => {
        await store.createProject({name: 'pantry', key: 'PAN'})
        expect((await store.settings()).starts).toBeNull()
        expect((await store.project('greenhouse')).starts).toBeUndefined()
        expect((await failure(() => store.updateSettings({starts: {limit: 1, minutes: 30}}))).status).toBe(403)
        changes.length = 0
        expect((await store.updateSettings({starts: {limit: 2, minutes: 30}}, owner)).starts).toEqual({limit: 2, minutes: 30})
        // Every project has it, and says so.
        expect((await store.project('pantry')).starts).toEqual({limit: 2, minutes: 30})
        expect(changes.sort()).toEqual(['greenhouse', 'pantry'])
        // Without minutes, they run until stopped; idle minutes stop one that has nothing to do.
        expect((await store.updateSettings({starts: {limit: 2}}, owner)).starts).toEqual({limit: 2})
        expect((await store.updateSettings({starts: {limit: 2, minutes: null, idle_minutes: 60}}, owner)).starts).toEqual({limit: 2, idle_minutes: 60})
        // A minimum kept running, up to the limit.
        expect((await store.updateSettings({starts: {limit: 3, min: 3, minutes: 60}}, owner)).starts).toEqual({limit: 3, min: 3, minutes: 60})
        expect((await store.updateSettings({starts: {limit: 3, min: null}}, owner)).starts).toEqual({limit: 3})
        // Work finding nobody listening starts one unless turned off, which is all that's kept.
        expect((await store.updateSettings({starts: {limit: 3, on_signal: false}}, owner)).starts).toEqual({limit: 3, on_signal: false})
        expect((await store.updateSettings({starts: {limit: 3, on_signal: true}}, owner)).starts).toEqual({limit: 3})
        for (const wrong of [{limit: 2, on_signal: 'no'}, {limit: 2, min: 3}, {limit: 2, min: 0}, {limit: 0, minutes: 30}, {minutes: 30}, {limit: 2, minutes: 0}, {limit: 2, idle_minutes: 1441}, {limit: 2, minutes: 30, model: 'x'}, {limit: 1.5, minutes: 30}, 'yes']) {
            expect((await failure(() => store.updateSettings({starts: wrong}, owner))).status).toBe(400)
        }
        expect((await store.updateSettings({starts: null}, owner)).starts).toBeNull()
        expect((await store.project('greenhouse')).starts).toBeUndefined()
        // A project has none of its own.
        expect((await failure(() => store.updateProject('greenhouse', {starts: {limit: 1}}, owner))).status).toBe(400)
    })

    it('reads without building the board', async () => {
        await store.updateSettings({starts: {limit: 1, minutes: 45}}, owner)
        expect(await store.starts('greenhouse')).toEqual({limit: 1, minutes: 45})
        expect((await failure(() => store.starts('nope'))).status).toBe(404)
    })
})
describe('a signal reaching sessions', () => {
    it('keeps every session that says it got it, however many say so at once', async () => {
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        const signal = await store.focus('greenhouse', jars, {}, {name: 'skoll', owner: true})
        await Promise.all(['greenhouse 1', 'greenhouse 2', 'pantry'].map(name => store.delivered('greenhouse', signal.id, name)))
        const [heard] = await store.listSignals('greenhouse', signal.id - 1)
        expect([...heard!.delivered_to].sort()).toEqual(['greenhouse 1', 'greenhouse 2', 'pantry'])
    })

    it("says so when it can't keep a session's receipt, rather than one it didn't save", async () => {
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        const signal = await store.focus('greenhouse', jars, {}, {name: 'skoll', owner: true})
        // Every write loses its race to another session's.
        const losing = Object.assign(Object.create(store) as Store, {run: async () => ({changes: 0})})
        expect((await failure(() => losing.delivered('greenhouse', signal.id, 'greenhouse 1'))).status).toBe(409)
        const [heard] = await store.listSignals('greenhouse', signal.id - 1)
        expect(heard!.delivered_to).toEqual([])
    })
})
describe('a focus aimed at no session', () => {
    it("goes to the session already on its issue while it's listening, else to one orrery picks", async () => {
        const owner = {name: 'skoll', owner: true}
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        expect((await store.focus('greenhouse', jars, {}, owner)).target).toBeUndefined()
        await store.workedBy('greenhouse', jars, 'a')
        store.hears = () => true
        expect((await store.focus('greenhouse', jars, {}, owner)).target).toBe('a')
        expect((await store.focus('greenhouse', jars, {session: '*'}, owner)).target).toBe('*')
        store.hears = () => false
        expect((await store.focus('greenhouse', jars, {}, owner)).target).toBeUndefined()
    })

    it('waits for the next session to go idle while nobody has heard it', async () => {
        const owner = {name: 'skoll', owner: true}
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        const one = await store.focus('greenhouse', jars, {}, owner)
        await store.focus('greenhouse', jars, {session: 'b'}, owner)
        const chunk = await store.focusChunk('greenhouse', 'all', {}, owner)
        expect((await store.pooledWaiting('greenhouse')).map(s => s.id)).toEqual([one.id, chunk.id])
        await store.delivered('greenhouse', one.id, 'pantry')
        expect((await store.pooledWaiting('greenhouse')).map(s => s.id)).toEqual([chunk.id])
    })
})
describe("what a project's sessions are on", () => {
    it('is the open issues each worked last, newest first, and the last signals that went to it', async () => {
        const owner = {name: 'skoll', owner: true}
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-progress'})).id
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        const lids = (await store.createIssue('greenhouse', {title: 'Lids', status: 'done'})).id
        await store.workedBy('greenhouse', shelves, 'a')
        await store.workedBy('greenhouse', lids, 'a')
        await store.workedBy('greenhouse', jars, 'a')
        // a is gone by then, so the focus hands Shelves to b.
        store.hears = (_project, session) => session !== 'a'
        await store.focus('greenhouse', shelves, {session: 'b'}, owner)
        store.hears = () => true
        const everyone = await store.focus('greenhouse', jars, {session: '*'}, owner)
        await store.delivered('greenhouse', everyone.id, 'pantry')
        const work = await store.sessionWork('greenhouse', [{id: 'a', name: 'greenhouse 1'}, {id: 'b', name: 'pantry'}])
        expect(work.a!.issues.map(i => i.id)).toEqual([jars])
        expect(work.a!.signals).toEqual([])
        // b was asked to focus on Shelves, which makes it Shelves' worker; and it heard the focus on Jars sent to all.
        expect(work.b!.issues.map(i => i.id)).toEqual([shelves])
        expect(work.b!.signals.map(s => s.issue)).toEqual([jars, shelves])
        // After a /clear, b goes by a new id and keeps what it did under the old one, each issue once.
        await store.workedBy('greenhouse', shelves, 'b2')
        const cleared = await store.sessionWork('greenhouse', [{id: 'b2', name: 'pantry', ids: ['b2', 'b']}])
        expect(cleared.b2!.issues.map(i => i.id)).toEqual([shelves])
        expect(cleared.b2!.signals.map(s => s.issue)).toEqual([jars, shelves])
    })

    it('says when each took its issue, kept while it works it again (ORR-536)', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-progress'})).id
        const since = async (session: string) => (await store.sessionWork('greenhouse', [{id: session, name: session}]))[session]!.issues[0]?.since
        vi.useFakeTimers({toFake: ['Date']})
        try {
            vi.setSystemTime(new Date('2026-10-29T09:00:00Z'))
            await store.workedBy('greenhouse', shelves, 'a')
            vi.setSystemTime(new Date('2026-10-29T09:20:00Z'))
            await store.workedBy('greenhouse', shelves, 'a')
            expect(await since('a')).toBe('2026-10-29T09:00:00.000Z')
            // Another session taking it starts the clock again.
            vi.setSystemTime(new Date('2026-10-29T09:30:00Z'))
            await store.workedBy('greenhouse', shelves, 'b')
            expect(await since('b')).toBe('2026-10-29T09:30:00.000Z')
        } finally {
            vi.useRealTimers()
        }
    })
})
describe('a session that connects', () => {
    it("knows an owner's focus on an issue is on its way until a session hears it (ORR-515)", async () => {
        const local = new Store(testDb())
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const a = (await local.createIssue('greenhouse', {title: 'A'})).id
        expect(await local.focusOnItsWay('greenhouse', a)).toBe(false)
        await local.focus('greenhouse', a, {}, {name: 'claude', owner: false})
        expect(await local.focusOnItsWay('greenhouse', a)).toBe(false)
        const focus = await local.focus('greenhouse', a, {}, {name: 'skoll', owner: true})
        expect(await local.focusOnItsWay('greenhouse', a)).toBe(true)
        await local.delivered('greenhouse', focus.id, 'Ny')
        expect(await local.focusOnItsWay('greenhouse', a)).toBe(false)
    })

    it("gets the owner's comments that no agent has answered", async () => {
        const sent: string[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(`${signal.issue}:${signal.target}:${signal.note}`))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const me = {name: 'skoll', owner: true}
        const a = (await local.createIssue('greenhouse', {title: 'A'})).id
        const b = (await local.createIssue('greenhouse', {title: 'B'})).id
        await local.createComment('greenhouse', a, {body: 'answer me'}, me)
        await local.createComment('greenhouse', b, {body: 'answered'}, me)
        await local.createComment('greenhouse', b, {body: 'here you go'}, {name: 'claude', owner: false})
        sent.length = 0
        // Still in the pool for one session to take, it isn't sent again (ORR-513)…
        expect(await local.carryUnanswered('greenhouse', 'new-window')).toBe(0)
        // …but once nobody took it in a day, the session that connects gets it.
        await local.db.run("UPDATE signals SET created_at = ? WHERE kind = 'comment'", new Date(Date.now() - 2 * 86_400_000).toISOString())
        expect(await local.carryUnanswered('greenhouse', 'new-window')).toBe(1)
        expect(sent).toEqual([`${a}:new-window:answer me`])
    })

    it("still gets the owner's comment when only orrery has spoken since, not an agent (ORR-528)", async () => {
        const sent: string[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(`${signal.issue}:${signal.target}:${signal.note}`))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const a = (await local.createIssue('greenhouse', {title: 'A'})).id
        await local.createComment('greenhouse', a, {body: 'rebase this'}, {name: 'skoll', owner: true})
        await local.systemComment('greenhouse', a, '#12 conflicts with `main`.', 'pr.conflicting')
        // Nobody took either from the pool in a day.
        await local.db.run("UPDATE signals SET created_at = ? WHERE kind = 'comment'", new Date(Date.now() - 2 * 86_400_000).toISOString())
        sent.length = 0
        expect(await local.carryUnanswered('greenhouse', 'new-window')).toBe(1)
        expect(sent).toEqual([`${a}:new-window:rebase this`])
    })

    it("aims the owner's comment on an issue nobody is on at no session, for one to take, and the pool offers it (ORR-513)", async () => {
        const sent: (string | undefined)[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(signal.target))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const a = (await local.createIssue('greenhouse', {title: 'A'})).id
        await local.createComment('greenhouse', a, {body: 'svg?'}, {name: 'skoll', owner: true})
        expect(sent).toEqual([undefined])
        expect((await local.pooledWaiting('greenhouse')).map(s => [s.kind, s.note])).toEqual([['comment', 'svg?']])
    })
})
describe('what a session is working on', () => {
    it('is the started issues any of its ids worked last, with their latest comment', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-progress'})).id
        const jars = (await store.createIssue('greenhouse', {title: 'Jars', status: 'in-review'})).id
        const lids = (await store.createIssue('greenhouse', {title: 'Lids', status: 'done'})).id
        const theirs = (await store.createIssue('greenhouse', {title: 'Theirs', status: 'in-progress'})).id
        for (const issue of [shelves, lids]) await store.workedBy('greenhouse', issue, 'before-clear')
        await store.workedBy('greenhouse', jars, 'after-clear')
        await store.workedBy('greenhouse', theirs, 'other-window')
        await store.createComment('greenhouse', shelves, {body: 'first'})
        await store.createComment('greenhouse', shelves, {body: 'halfway'})
        const working = await store.workingOn('greenhouse', ['after-clear', 'before-clear'])
        expect(working.map(i => [i.id, i.last?.body])).toEqual([[shelves, 'halfway'], [jars, undefined]])
        expect(await store.workingOn('greenhouse', [])).toEqual([])
    })

    it("moves to a session's new id: what it worked and the signals sent to it", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-progress'})).id
        await store.workedBy('greenhouse', shelves, 'before-clear')
        await store.focus('greenhouse', shelves, {session: 'before-clear'})
        await store.renameSession('greenhouse', 'before-clear', 'after-clear')
        expect((await store.workingOn('greenhouse', ['after-clear'])).map(i => i.id)).toEqual([shelves])
        expect(await store.workingOn('greenhouse', ['before-clear'])).toEqual([])
        expect((await store.listSignals('greenhouse')).map(s => s.target)).toEqual(['after-clear'])
    })
})
describe('a message to one session', () => {
    const owner = {name: 'skoll', owner: true}

    it("is the owner's, as text, a message signal for that session alone", async () => {
        expect((await failure(() => store.messageSession('greenhouse', 'abc', 'Look at the hinges'))).status).toBe(403)
        expect((await failure(() => store.messageSession('greenhouse', 'abc', '  ', owner))).status).toBe(400)
        expect((await failure(() => store.messageSession('nope', 'abc', 'Hi', owner))).status).toBe(404)
        const signal = await store.messageSession('greenhouse', 'abc', ' Look at the hinges\n', owner)
        expect(signal).toMatchObject({kind: 'message', note: 'Look at the hinges', target: 'abc', schedule: undefined, issue: undefined, created_by: 'skoll', protected: true})
        // Nobody else catches up on it, but the session it's for does, if it wasn't there to hear it.
        expect((await store.unheardScheduled('greenhouse')).map(s => s.target)).toEqual(['abc'])
    })

    it("sent by the owner's chat for them says so", async () => {
        const signal = await store.messageSession('greenhouse', 'abc', 'Pick up Todo.', {...owner, via: 'chat'})
        expect(signal).toMatchObject({kind: 'message', created_by: 'skoll', protected: true, via: 'chat'})
        expect((await store.listSignals('greenhouse')).find(s => s.id === signal.id)!.via).toBe('chat')
        expect(await store.messageSession('greenhouse', 'abc', 'Hi', owner)).not.toHaveProperty('via')
    })

    it("from a preset is its text as the owner sent it, labelled by the preset's name as it was then", async () => {
        const release = await store.createPreset('greenhouse', {name: 'Release', text: 'Cut the release.'}, owner)
        await store.createProject({name: 'pantry', key: 'PAN'})
        const jars = await store.createPreset('pantry', {name: 'Jars', text: 'Mind the jars.'}, owner)
        const signal = await store.messageSession('greenhouse', 'abc', 'Cut the release, for rc.9.', owner, release.id)
        expect(signal).toMatchObject({kind: 'message', note: 'Cut the release, for rc.9.', preset: 'Release', target: 'abc'})
        await store.updatePreset(release.id, {name: 'Ship it'}, owner)
        expect((await store.listSignals('greenhouse')).find(s => s.id === signal.id)!.preset).toBe('Release')
        // Another project's preset, one that isn't there, or not an id, is refused; without one, it's plain words.
        expect((await failure(() => store.messageSession('greenhouse', 'abc', 'Hi', owner, jars.id))).status).toBe(400)
        expect((await failure(() => store.messageSession('greenhouse', 'abc', 'Hi', owner, 999))).status).toBe(400)
        expect((await failure(() => store.messageSession('greenhouse', 'abc', 'Hi', owner, 'Release'))).status).toBe(400)
        expect((await store.messageSession('greenhouse', 'abc', 'Hi', owner)).preset).toBeUndefined()
    })
})
