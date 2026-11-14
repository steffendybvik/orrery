import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'
import {exportBoard} from '../server/utils/board-export'

// Who counts as a member asking in person, and bringing in a board's file (ORR-696). The key, login and invite routes are
// the Rust API's now (ORR-1041), and logging in and out too (ORR-1137): their rules are tested there (people_tests.rs,
// api-parity.test.ts). Each request
// goes through the real auth middleware and then the route, against a real store, on events standing in for requests.
// Nitro's auto-imports are stood in for here.
type Event = {path: string, method: string, headers: Record<string, string>, context: Record<string, unknown>, node: {req: unknown}, body?: unknown, params?: Record<string, string>, status?: number}
type Route = (event: Event) => Promise<unknown>
type Asked = {method?: string, headers?: Record<string, string>, body?: unknown, key?: string}

let store: StoreType
let config: Record<string, unknown>
let gate: Route
let cookies: {name: string, value: string, options: Record<string, unknown>}[]
let removed: string[]

const ORIGIN = {origin: 'http://localhost:9000'}
const bearer = (key: string) => ({authorization: `Bearer ${key}`})

/** The request through the middleware and on to the route, with what the route returned and the status it set. */
async function ask(load: () => Promise<{default: unknown}>, path: string, {method = 'GET', headers = {}, body, key}: Asked = {}) {
    const event: Event = {
        path, method, headers, context: {}, body, params: key ? {key, login: key} : {},
        node: {req: {headers, socket: {remoteAddress: '127.0.0.1', server: {address: () => ({address: '127.0.0.1'})}}}},
    }
    await gate(event)
    const route = (await load()).default as Route
    return {data: await route(event), status: event.status ?? 200}
}

/** The login secret in a browser's cookie. */
const loginOf = (headers: {cookie: string}) => headers.cookie.split('=')[1]!

/** A person's browser: logged in with a person key, as the page is, its writes saying they come from a page. */
async function browser(person: string) {
    const {key} = await store.makeKey(person, {kind: 'person', name: 'browser'})
    const {secret} = await store.startLogin(person, key)
    return {cookie: `orrery_login=${secret}`, ...ORIGIN}
}

beforeEach(async () => {
    ({store} = await storeSetup())
    config = {auth: 'on', oidc: {issuer: '', clientId: '', clientSecret: ''}, listenHost: ''}
    cookies = []
    removed = []
    const fail = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('getCookie', (event: Event, name: string) => new RegExp(`${name}=([^;]+)`).exec(event.headers.cookie ?? '')?.[1])
    vi.stubGlobal('setCookie', (_: Event, name: string, value: string, options: Record<string, unknown>) => cookies.push({name, value, options}))
    vi.stubGlobal('deleteCookie', (_: Event, name: string) => removed.push(name))
    vi.stubGlobal('getRequestProtocol', () => 'http')
    vi.stubGlobal('getRequestURL', () => new URL('http://localhost:9000/api/invites'))
    vi.stubGlobal('createError', (input: {statusCode: number, message: string}) => Object.assign(new Error(input.message), input))
    vi.stubGlobal('sessionName', (name: string | undefined) => name)
    vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
    vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
    vi.stubGlobal('readBody', async (event: Event) => event.body)
    vi.stubGlobal('param', (event: Event, name: string) => event.params?.[name])
    vi.stubGlobal('setResponseStatus', (event: Event, status: number) => event.status = status)
    vi.stubGlobal('conflict', fail(409))
    vi.stubGlobal('badRequest', fail(400))
    vi.resetModules()
    const actor = await import('../server/utils/actor')
    vi.stubGlobal('actorOf', actor.actorOf)
    const auth = await import('../server/utils/auth')
    vi.stubGlobal('logIn', auth.logIn)
    vi.stubGlobal('LOGIN_COOKIE', auth.LOGIN_COOKIE)
    vi.stubGlobal('loginCookie', auth.loginCookie)
    vi.stubGlobal('oidcOn', (await import('../server/utils/oidc')).oidcOn)
    const {authorize, memberAsking} = await import('../server/utils/authorize')
    vi.stubGlobal('authorize', authorize)
    vi.stubGlobal('memberAsking', memberAsking)
    vi.stubGlobal('refusedFor', (await import('../server/utils/permission')).refusedFor)
    gate = (await import('../server/middleware/auth')).default as unknown as Route
    await store.nameOwner({name: 'Skoll'})
    await store.addPerson({name: 'Hati'})
    // A claimed server, as anyone could log in to: one nobody can answers 503, not 401.
    await store.makeKey('skoll', {kind: 'person', name: 'claim'})
})

afterEach(() => vi.unstubAllGlobals())

describe('a removed person', () => {
    it('loses their login', async () => {
        const hati = await browser('hati')
        await store.removePerson('hati', {name: 'skoll', owner: true})
        expect(await store.loginHolder(loginOf(hati))).toBeUndefined()
    })
})

describe('a member asking in person (`memberAsking`, ORR-746)', () => {
    const asking = async (headers: Record<string, string>) => {
        const {memberAsking} = await import('../server/utils/authorize')
        return (await ask(async () => ({default: memberAsking}), '/api/notices/clear', {method: 'POST', headers})).data
    }

    it('counts their own login as them, and no one else\'s', async () => {
        expect(await asking(await browser('hati'))).toMatchObject({person: 'hati'})
        expect(await asking(await browser('skoll'))).toBeUndefined()
    })

    it('never counts an agent of theirs, with its key or by saying their name', async () => {
        const {key} = await store.makeKey('hati', {kind: 'agent', name: 'a session'})
        expect(await asking(bearer(key))).toBeUndefined()
        expect(await asking({...bearer(key), 'orrery-actor': 'hati', 'orrery-person': 'hati'})).toBeUndefined()
    })

    it('with login off, goes by the name sent: a session working for them isn\'t them, nor the chat, nor an untrusted one', async () => {
        config.auth = 'off'
        expect(await asking({'orrery-actor': 'hati'})).toMatchObject({person: 'hati'})
        expect(await asking({'orrery-actor': 'hati', 'orrery-person': 'hati'})).toMatchObject({person: 'hati'})
        expect(await asking({'orrery-actor': 'claude', 'orrery-person': 'hati'})).toBeUndefined()
        expect(await asking({'orrery-actor': 'hati', 'orrery-chat': 'yes'})).toBeUndefined()
        expect(await asking({'orrery-actor': 'hati', 'orrery-untrusted': 'yes'})).toBeUndefined()
        expect(await asking({'orrery-actor': 'skoll'})).toBeUndefined()
    })
})

describe("POST /api/projects/upload (a board's file)", () => {
    const upload = (headers: Record<string, string>, query: Record<string, string>) =>
        ask(() => import('../server/api/projects/upload.post'), '/api/projects/upload', {method: 'POST', headers, body: query})

    beforeEach(async () => {
        const file = JSON.stringify(await exportBoard(store.db, 'greenhouse'))
        vi.stubGlobal('readRawBody', async () => file)
        // The query rides in the event's body here, as nothing else reads it.
        vi.stubGlobal('getQuery', (event: Event) => event.body)
        vi.stubGlobal('useDatabase', () => store.db)
        vi.stubGlobal('personOf', (await import('../server/utils/actor')).personOf)
        vi.stubGlobal('useEventLog', () => ({note: () => {}}))
        vi.stubGlobal('setResponseStatus', (event: Event, status: number) => event.status = status)
        vi.stubGlobal('created', (event: Event, value: unknown) => (event.status = 201, value))
        const upload = await import('../server/utils/board-upload')
        vi.stubGlobal('uploadBoard', upload.uploadBoard)
        vi.stubGlobal('checkedBoard', upload.checkedBoard)
        vi.stubGlobal('boardForApi', upload.boardForApi)
        // No API here, so the store writes it.
        vi.stubGlobal('writeToApi', async () => undefined)
        vi.stubGlobal('ownerNow', async () => store.ownerOf())
        vi.stubGlobal('BOARD_LIMIT', 256 * 1024 * 1024)
    })

    it('lets a member bring one in as a board they hold, as the table and the API say (ORR-725)', async () => {
        const made = await upload(await browser('hati'), {id: 'hatis', key: 'HAT'})
        expect(made.status).toBe(201)
        expect(await store.holdsBoard('hatis', 'hati')).toBe(true)
    })

    it("refuses a member's agent, with its key or by saying their name", async () => {
        const {key} = await store.makeKey('hati', {kind: 'agent', name: 'a session'})
        expect((await failure(() => upload(bearer(key), {id: 'theirs', key: 'THE'}))).status).toBe(403)
        config.auth = 'off'
        expect((await failure(() => upload({'orrery-actor': 'claude', 'orrery-person': 'hati'}, {id: 'theirs', key: 'THE'}))).status).toBe(403)
        expect(await store.db.get("SELECT 1 FROM projects WHERE id = 'theirs'")).toBeUndefined()
    })
})
