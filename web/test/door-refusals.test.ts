// A refused request answers the same through the router and the API (ORR-1113). Nuxt's data routes are gone (ORR-1041),
// so a door refusal can't be compared with a Nuxt route's any more; what's left to compare is the router's middleware
// (auth.ts, board.ts, chat.ts, untrusted.ts, writes.ts, then zz-api.ts) against the Rust API's own guard (request.rs,
// access/rails.rs), which holds the same doors for a request that reaches it with the token and no Nuxt in front. Each
// request here goes both ways on one database: through the middleware the Nuxt server runs, and straight to the API with
// the headers the router sends (`forwardToApi`), and the two refusals have to match in status, words and the permissions
// row they name. The API being down is pinned in api-only.test.ts. The API is the binary `cargo build` makes
// (api/target/debug/orrery-api, or ORRERY_API_BIN); without one this is skipped, and CI's `api` job builds it first.
import type {ChildProcess} from 'node:child_process'
import {spawn} from 'node:child_process'
import {existsSync, mkdtempSync} from 'node:fs'
import {IncomingMessage, ServerResponse} from 'node:http'
import {Socket} from 'node:net'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as h3 from 'h3'
import type {H3Event} from 'h3'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {Store} from '../server/utils/store'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import type {Who} from '../server/utils/auth'

const BIN = process.env.ORRERY_API_BIN || fileURLToPath(new URL('../../api/target/debug/orrery-api', import.meta.url))
const TOKEN = 'door-token-0123456789abc'

/** How a request came: over loopback or from another machine, with a cookie or a key, from a page or not. */
interface Asking {method?: string, path: string, headers?: Record<string, string>, loopback?: boolean}

/** A refusal as the page gets it. */
interface Refusal {statusCode: number, statusMessage: string, message: string, data?: unknown}

type Handler = (event: H3Event) => unknown

/** One orrery: its store, and the API on the same file. */
interface Running {store: Store, setting: string, url: string, api: ChildProcess}

let config: Record<string, unknown> = {}
let orrery: Running
let middleware: Handler[] = []
let forwardToApi: typeof import('../server/utils/api-router').forwardToApi
let credential: typeof import('../server/utils/auth').credential

/** A database with `greenhouse` on it, and the API started on the same file. */
async function startOrrery(): Promise<Running> {
    // Seeded with no API in front, as the store's reads ask it once one is set up (ORR-1133).
    config = {}
    const setting = resolve(join(mkdtempSync(join(tmpdir(), 'orrery-doors-')), 'orrery.db'))
    const store = new Store(new SqliteDb(openDb(setting)), () => {})
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.nameOwner({name: 'Skoll'})
    const api = spawn(BIN, [], {env: {...process.env, NUXT_API_TOKEN: TOKEN, NUXT_DATABASE: setting, ORRERY_API_LISTEN: '127.0.0.1:0'}})
    const url = await new Promise<string>((done, fail) => {
        let said = ''
        api.stderr!.on('data', (chunk: Buffer) => {
            said += chunk
            const at = /serving docs on (http:\/\/\S+),/.exec(said)
            if (at) done(at[1]!)
        })
        api.on('exit', code => fail(new Error(`the API stopped (${code}): ${said}`)))
    })
    return {store, setting, url, api}
}

/** A request as h3 would hand it on: on a loopback listener or one others can reach, from a client on that address. */
function eventOf({method = 'GET', path, headers = {}, loopback = true}: Asking): H3Event {
    const socket = new Socket()
    const address = loopback ? '127.0.0.1' : '192.0.2.7'
    Object.defineProperty(socket, 'remoteAddress', {value: address})
    Object.defineProperty(socket, 'localPort', {value: 9000})
    Object.assign(socket, {server: {address: () => ({address: loopback ? '127.0.0.1' : '0.0.0.0'})}})
    const req = new IncomingMessage(socket)
    req.url = path
    req.method = method
    req.headers = {host: 'localhost:9000', ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))}
    return h3.createEvent(req, new ServerResponse(req))
}

/** What a call threw, as the page would read it. */
async function refusalOf(run: () => unknown): Promise<Refusal | 'let through'> {
    try {
        await run()
        return 'let through'
    } catch (error) {
        const {statusCode, statusMessage, message, data} = error as Refusal
        return {statusCode, statusMessage, message, ...data === undefined ? {} : {data}}
    }
}

/** The request through the router: each middleware the Nuxt server runs before it, in its order, then the router itself. */
const throughRouter = (asking: Asking) => refusalOf(async () => {
    const event = eventOf(asking)
    for (const handler of middleware) {
        const reply = await handler(event)
        if (reply !== undefined) return reply
    }
})

/** The request straight to the API, with the headers the router sends it and none of the middleware's checks first. */
const toApi = (asking: Asking) => refusalOf(async () => {
    const event = eventOf(asking)
    if (config.auth !== 'off') event.context.who = await credential(event).catch(() => undefined) as Who | undefined
    return await forwardToApi(event, {url: orrery.url, token: TOKEN})
})

/** Both ways refuse it, in the same status and words. */
async function refusedAlike(asking: Asking, status: number, says: RegExp | string) {
    const [router, api] = [await throughRouter(asking), await toApi(asking)]
    expect(router, `the router, ${asking.method ?? 'GET'} ${asking.path}`).toMatchObject({statusCode: status})
    expect((router as Refusal).message).toMatch(says)
    expect(api, `the API, ${asking.method ?? 'GET'} ${asking.path}`).toEqual(router)
}

describe.skipIf(!existsSync(BIN))('a refused request answers the same through the router and the API', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.spyOn(console, 'info').mockImplementation(() => {})
        // Nitro's auto-imports, stood in for by the real ones, but for what only a running server knows: the sessions
        // and chats it started (none here) and the event log.
        for (const name of ['getHeader', 'getCookie', 'createError', 'getRequestHost', 'getRequestHeader', 'getRequestURL', 'getRequestProtocol', 'setResponseHeader', 'setResponseHeaders', 'setResponseStatus', 'readRawBody', 'getQuery'] as const) {
            vi.stubGlobal(name, h3[name])
        }
        vi.stubGlobal('defineEventHandler', (handler: Handler) => handler)
        vi.stubGlobal('useRuntimeConfig', () => config)
        vi.stubGlobal('useStore', () => orrery.store)
        vi.stubGlobal('useEventLog', () => ({note: () => {}}))
        vi.stubGlobal('databaseSetting', () => orrery.setting)
        vi.stubGlobal('sessionName', (id: string | undefined) => id)
        vi.stubGlobal('currentId', (id: string) => id)
        vi.stubGlobal('chatIssuesFor', () => 'todo')
        vi.stubGlobal('untrustedProject', () => undefined)
        const input = await import('../server/utils/input')
        const actor = await import('../server/utils/actor')
        const permission = await import('../server/utils/permission')
        const guard = await import('../server/utils/guard')
        const board = await import('../server/utils/board')
        const events = await import('../server/utils/events')
        for (const [name, value] of Object.entries({...input, ...actor, ...permission, ...guard, ...board, decoded: events.decoded})) vi.stubGlobal(name, value)
        // As utils/chats.ts and utils/untrusted.ts have them, less the sessions this server started, of which there are none.
        vi.stubGlobal('chatWrite', (event: H3Event) => !actor.anotherPersons(event) && h3.getHeader(event, 'orrery-chat') === 'yes')
        vi.stubGlobal('untrustedWrite', (event: H3Event) => !actor.anotherPersons(event) && h3.getHeader(event, 'orrery-untrusted') === 'yes')
        ;({credential} = await import('../server/utils/auth'))
        ;({forwardToApi} = await import('../server/utils/api-router'))
        middleware = await Promise.all(['auth', 'board', 'chat', 'untrusted', 'writes', 'zz-api'].map(async name => (await import(`../server/middleware/${name}.ts`)).default as Handler))
    }, 30_000)

    afterEach(() => {
        config = {apiUrl: orrery?.url, apiToken: TOKEN}
    })

    afterAll(() => {
        orrery?.api.kill()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    describe('one person, at the login guard and on the rails', () => {
        beforeAll(async () => {
            orrery = await startOrrery()
            config = {apiUrl: orrery.url, apiToken: TOKEN}
        }, 30_000)
        afterAll(() => orrery.api.kill())

        it("refuses the chat what its column doesn't let it do, naming the row (403)", async () => {
            await refusedAlike({method: 'POST', path: '/api/statuses', headers: {'orrery-chat': 'yes', 'orrery-session': 'c-1'}}, 403, /the owner's chat/)
            const router = await throughRouter({method: 'POST', path: '/api/statuses', headers: {'orrery-chat': 'yes'}})
            expect(router).toMatchObject({data: {permission: expect.any(String)}})
        })

        it('refuses an untrusted session anything but proposals and comments on them (403)', async () => {
            await refusedAlike({method: 'DELETE', path: '/api/projects/greenhouse/docs/notes', headers: {'orrery-untrusted': 'yes', 'orrery-session': 'u-1'}}, 403, /an untrusted schedule/)
            await refusedAlike({method: 'POST', path: '/api/projects/greenhouse/milestones', headers: {'orrery-untrusted': 'yes'}}, 403, /an untrusted schedule/)
        })

        it("is closed with ORRERY_AUTH=off on an orrery others can reach (503)", async () => {
            config = {...config, auth: 'off'}
            await refusedAlike({path: '/api/statuses', loopback: false}, 503, /ORRERY_AUTH=off only works/)
        })

        it('turns away a request from another machine while nobody can log in yet (503)', async () => {
            await refusedAlike({path: '/api/projects/greenhouse/docs', loopback: false}, 503, /Nobody can log in to this orrery yet/)
        })
    })

    describe('more than one person, at the login guard, the origin check, the claim check and the rails', () => {
        const keys: Record<string, string> = {}
        let login = ''

        beforeAll(async () => {
            orrery = await startOrrery()
            config = {apiUrl: orrery.url, apiToken: TOKEN}
            const {store} = orrery
            await store.addPerson({name: 'Hati'})
            await store.addMember('greenhouse', {person: 'hati'}, {name: 'skoll', owner: true})
            await store.createProject({name: 'attic', key: 'ATT'})
            await store.makeKey('skoll', {kind: 'person', name: 'claim'})
            keys.skoll = (await store.makeKey('skoll', {kind: 'agent', name: 'desk'})).key
            keys.hati = (await store.makeKey('hati', {kind: 'agent', name: 'laptop'})).key
            login = (await store.startLogin('hati')).secret
            // Hati's agent wrote as session `w` first, so it's hers.
            await store.fixSessionPerson('w', 'hati')
        }, 30_000)
        afterAll(() => orrery.api.kill())

        const as = (who: string, more: Record<string, string> = {}) => ({authorization: `Bearer ${keys[who]}`, ...more})

        it('asks a request with no credential for one, reads too (401)', async () => {
            await refusedAlike({path: '/api/projects/greenhouse/docs'}, 401, /asks for a credential/)
            await refusedAlike({method: 'POST', path: '/api/projects/greenhouse/docs', loopback: false}, 401, /asks for a credential/)
        })

        it("refuses a logged-in browser's write that doesn't say it's from a page (403)", async () => {
            await refusedAlike({method: 'POST', path: '/api/projects/greenhouse/docs', headers: {cookie: `orrery_login_9000=${login}`}}, 403, /comes from orrery's own page/)
        })

        it("refuses an agent key writing as another person's session (409)", async () => {
            await refusedAlike({method: 'POST', path: '/api/projects/greenhouse/docs', headers: as('skoll', {'orrery-session': 'w'})}, 409, /This session is hati's, and this is skoll's agent key/)
        })

        it("answers a member's write to a board they aren't on as if it weren't there (404)", async () => {
            await refusedAlike({method: 'POST', path: '/api/projects/attic/docs', headers: as('hati')}, 404, /No project attic/)
        })

        it("refuses a member what's the owner's alone, naming the row (403)", async () => {
            await refusedAlike({method: 'POST', path: '/api/statuses', headers: as('hati')}, 403, /the owner's alone for now/)
        })

        it('refuses a session that names nobody a change, with ORRERY_AUTH=off (409)', async () => {
            config = {...config, auth: 'off'}
            await refusedAlike({method: 'POST', path: '/api/projects/greenhouse/milestones', headers: {'orrery-actor': 'claude'}}, 409, /This session names nobody/)
            await refusedAlike({method: 'POST', path: '/api/projects/greenhouse/milestones', headers: {'orrery-actor': 'claude', 'orrery-person': 'manni'}}, 409, /"manni" isn't anyone on this orrery/)
        })
    })
})
