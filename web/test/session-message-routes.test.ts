import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Writing to a session, through its routes (ORR-1324): the owner's message to one session, to every listening one, and
// the channel's receipt. The sessions are the real ones (server/utils/sessions.ts), so what counts as there to hear is
// what the server goes by; the store and the h3 helpers are Nitro auto-imports, stood in for.
let sessions: typeof import('../server/utils/sessions')
let sent: {project: string, session: string, text: unknown, preset?: unknown}[]
let receipts: {project: string, signal: number, name: string}[]
let logged: string[]
/** The projects listed to the asker, as `listedSees` gives them: every one with login off. */
let seen: Set<string> | undefined

type Event = {params?: Record<string, string>, body?: unknown, query?: Record<string, string>, status?: number}
const httpError = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
const owner = {name: 'skoll', owner: true}

beforeEach(async () => {
    sent = []
    receipts = []
    logged = []
    seen = undefined
    vi.stubGlobal('projectEvents', new EventEmitter())
    const store = {
        workedBy: async () => {},
        renameSession: async () => {},
        messageSession: async (project: string, session: string, text: unknown, _actor: unknown, preset?: unknown) => {
            sent.push({project, session, text, preset})
            return {id: sent.length, project, target: session, kind: 'message', note: text}
        },
        delivered: async (project: string, signal: number, name: string) => {
            receipts.push({project, signal, name})
            return {id: signal, delivered_to: [name]}
        },
    }
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('launchTarget', (launch: string) => `launch-${launch}`)
    vi.resetModules()
    sessions = await import('../server/utils/sessions')
    for (const name of ['aimFor', 'listSessions', 'hearing', 'recipients', 'signalReached', 'sessionName', 'chatSession'] as const) vi.stubGlobal(name, sessions[name])
    // No stream listens under a name alone here (ORR-821).
    vi.stubGlobal('namedStream', () => false)
    vi.stubGlobal('EVERY', '*')
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('param', (event: Event, name: string) => event.params![name])
    vi.stubGlobal('readBody', async (event: Event) => event.body)
    vi.stubGlobal('getQuery', (event: Event) => event.query ?? {})
    vi.stubGlobal('authorize', async () => owner)
    vi.stubGlobal('listedSees', async () => seen)
    vi.stubGlobal('created', (event: Event, value: unknown) => {
        event.status = 201
        return value
    })
    vi.stubGlobal('messaged', (_actor: unknown, project: string, session: string) => void logged.push(`${project}: ${session}`))
    for (const [name, status] of [['badRequest', 400], ['notFound', 404], ['conflict', 409]] as const) vi.stubGlobal(name, httpError(status))
    vi.doMock('../server/utils/usage', () => ({countOwnUse: () => {}}))
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../server/utils/usage')
})

type Route = (event: Event) => Promise<unknown>
const route = async (path: string) => (await import(path)).default as Route
const toOne = (session: string, body: unknown, event: Event = {}) =>
    route('../server/api/projects/[project]/sessions/[session]/message.post').then(r => r(Object.assign(event, {params: {project: 'greenhouse', session}, body})))
const toAll = (body: unknown, event: Event = {}) => route('../server/api/sessions/message.post').then(r => r(Object.assign(event, {body})))
const receipt = (signal: number, query: Record<string, string>) =>
    route('../server/api/projects/[project]/signals/[signal]/delivered.post').then(r => r({params: {project: 'greenhouse', signal: String(signal)}, query}))

/** A session as its hook says it started, and, unless `booting`, its channel connected and heard. */
function session(id: string, {booting = false, project = 'greenhouse', heard = true} = {}) {
    sessions.report({id, project, event: 'SessionStart'})
    if (booting) return {done: () => {}}
    return sessions.attend(project, id, undefined, undefined, heard)
}

describe('a message to one session', () => {
    it('goes to a session whose channel is connected, by its id or its name, and says so in the event log', async () => {
        session('w')
        const name = sessions.sessionName('w')!
        const event: Event = {}
        expect(await toOne('w', {text: 'Water them.'}, event)).toMatchObject({target: 'w', note: 'Water them.'})
        expect(event.status).toBe(201)
        await toOne(name.split(' · ')[1]!, {text: 'And the jars.', preset: 3})
        expect(sent).toEqual([{project: 'greenhouse', session: 'w', text: 'Water them.', preset: undefined}, {project: 'greenhouse', session: 'w', text: 'And the jars.', preset: 3}])
        expect(logged).toEqual([`greenhouse: ${name}`, `greenhouse: ${name}`])
    })

    it('is refused, not queued, while the session is still starting and its channel hasn\'t connected (the bootstrap case)', async () => {
        session('w', {booting: true})
        await expect(toOne('w', {text: 'Are you there?'})).rejects.toMatchObject({statusCode: 409, message: expect.stringContaining("isn't listening, so a message can't reach it")})
        expect(sent).toEqual([])
        // Once it connects, the same message goes.
        sessions.attend('greenhouse', 'w', undefined, undefined)
        await toOne('w', {text: 'Are you there?'})
        expect(sent).toHaveLength(1)
    })

    it('is refused once its channel has gone, and goes again when it reconnects', async () => {
        const channel = session('w')
        channel.done()
        await expect(toOne('w', {text: 'Still there?'})).rejects.toMatchObject({statusCode: 409})
        session('w')
        await toOne('w', {text: 'Still there?'})
        expect(sent.map(s => s.text)).toEqual(['Still there?'])
    })

    it('is refused for a channel that can\'t hear (not started with the channel flag), and a 404 for a session not on the project', async () => {
        session('deaf', {heard: false})
        await expect(toOne('deaf', {text: 'Hello?'})).rejects.toMatchObject({statusCode: 409})
        session('elsewhere', {project: 'pantry'})
        await expect(toOne('elsewhere', {text: 'Hello?'})).rejects.toMatchObject({statusCode: 404, message: 'No session elsewhere in greenhouse'})
        await expect(toOne('nobody', {text: 'Hello?'})).rejects.toMatchObject({statusCode: 404})
        expect(sent).toEqual([])
    })

    it('sent twice is two messages: nothing folds the owner\'s own words', async () => {
        session('w')
        await toOne('w', {text: 'Water them.'})
        await toOne('w', {text: 'Water them.'})
        expect(sent).toHaveLength(2)
    })
})

describe('a message to every listening session', () => {
    it('goes to each idle one that hears, once each, and to none still starting', async () => {
        session('a')
        session('b')
        session('booting', {booting: true})
        session('deaf', {heard: false})
        for (const id of ['a', 'b', 'deaf']) sessions.report({id, project: 'greenhouse', event: 'Stop'})
        const event: Event = {}
        const reply = await toAll({text: 'Tea break.'}, event) as {sent: {session: string}[]}
        expect(event.status).toBe(201)
        expect(reply.sent.map(s => s.session).sort()).toEqual(['a', 'b'])
        expect(sent.map(s => s.session).sort()).toEqual(['a', 'b'])
    })

    it('leaves a working one be unless asked, narrows to the projects named, and sends nothing when nobody hears', async () => {
        session('a')
        sessions.report({id: 'a', project: 'greenhouse', event: 'UserPromptSubmit'})
        expect((await toAll({text: 'Tea break.'}) as {sent: unknown[]}).sent).toEqual([])
        expect((await toAll({text: 'Tea break.', states: ['working']}) as {sent: unknown[]}).sent).toHaveLength(1)
        expect((await toAll({text: 'Tea break.', states: ['working'], projects: ['pantry']}) as {sent: unknown[]}).sent).toEqual([])
    })

    // Another person's or another workspace's sessions are never reached, nor named (ORR-1370).
    it("reaches only sessions on the projects listed to the asker, and 404s one that isn't", async () => {
        session('mine')
        session('theirs', {project: 'bobs'})
        for (const [id, project] of [['mine', 'greenhouse'], ['theirs', 'bobs']]) sessions.report({id: id!, project: project!, event: 'Stop'})
        seen = new Set(['greenhouse'])
        expect((await toAll({text: 'Tea break.'}) as {sent: {session: string}[]}).sent.map(s => s.session)).toEqual(['mine'])
        await expect(toAll({text: 'Tea break.', projects: ['bobs']})).rejects.toMatchObject({statusCode: 404})
        expect(sent.map(s => s.session)).toEqual(['mine'])
    })

    it('refuses no text, lists that aren\'t lists of strings, and a state there isn\'t', async () => {
        for (const body of [{}, {text: '  '}, {text: 'x', projects: 'greenhouse'}, {text: 'x', states: [3]}, {text: 'x', states: ['asleep']}, null])
            await expect(toAll(body)).rejects.toMatchObject({statusCode: 400})
    })
})

describe("the channel's receipt", () => {
    it('names the session that heard it and sets it working once its hooks report, and is fine sent twice', async () => {
        session('w')
        const name = sessions.sessionName('w')!
        await receipt(4, {session: 'w'})
        await receipt(4, {session: 'w'})
        expect(receipts).toEqual([{project: 'greenhouse', signal: 4, name}, {project: 'greenhouse', signal: 4, name}])
        expect(sessions.sessionNow('w')?.state).toBe('working')
    })

    it('takes the name its stream gave when orrery doesn\'t know the session, else says "a session"', async () => {
        await receipt(5, {name: 'cellar'})
        await receipt(6, {})
        await receipt(7, {session: 'unknown'})
        expect(receipts.map(r => r.name)).toEqual(['cellar', 'a session', 'a session'])
    })
})
