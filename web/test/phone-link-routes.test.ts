import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'
import {LINK_MINUTES, PHONE_LOGIN, clearSignInLinks} from '../server/utils/phone-sign-in'

// The routes behind App settings' QR code (ORR-837, ORR-844). `POST /api/phone/link` hands out a login as the owner, so
// these hold its guards: never over the phone's port, never for a key, another person or a session. And over the
// phone's port nothing counts as this machine, whatever Host it names. Each request goes through the real auth
// middleware and then the route, against a real store, with the real `authorize`, `chatWrite` and `untrustedWrite`:
// stubbing those would hide what refuses the chat and an untrusted session. Nitro's auto-imports are stood in for here.
type Event = {path: string, method: string, headers: Record<string, string>, context: Record<string, unknown>, node: {req: unknown}, body?: unknown, status?: number}
type Route = (event: Event) => Promise<unknown>
type Asked = {method?: string, headers?: Record<string, string>, body?: unknown, phone?: boolean}

const PHONE_PORT = 9101
const PAGE = {host: 'localhost:9000', origin: 'http://localhost:9000'}
const bearer = (key: string) => ({authorization: `Bearer ${key}`})
const named = (name: string, more: Record<string, string> = {}) => ({'orrery-actor': name, ...more})

let store: StoreType
let config: Record<string, unknown>
let gate: Route
let cookies: {name: string, value: string, options: Record<string, unknown>}[]

/** A request from this machine, on the main port or the phone's, through the middleware and on to the route. */
function request(path: string, {method = 'POST', headers = {}, body, phone = false}: Asked): Event {
    const all = {...PAGE, ...headers}
    const socket = {remoteAddress: '127.0.0.1', localPort: phone ? PHONE_PORT : 9000, server: {address: () => ({address: '127.0.0.1'})}}
    return {path, method, headers: all, context: {}, body, node: {req: {headers: all, socket}}}
}
async function ask(load: () => Promise<{default: unknown}>, path: string, asked: Asked = {}) {
    const event = request(path, asked)
    await gate(event)
    const route = (await load()).default as Route
    return {data: await route(event), status: event.status ?? 200}
}
const makeLink = (asked: Asked = {}) => ask(() => import('../server/api/phone/link.post'), '/api/phone/link', asked)
const useLink = (token: unknown, asked: Asked = {}) => ask(() => import('../server/api/auth/link.post'), '/api/auth/link', {...asked, body: {token}})
const useCode = (code: unknown, asked: Asked = {}) => ask(() => import('../server/api/auth/link.post'), '/api/auth/link', {...asked, body: {code}})

/** A person's browser, logged in with a person key, as the page is. */
async function browser(person: string) {
    const {key} = await store.makeKey(person, {kind: 'person', name: 'browser'})
    // Logging in is the Rust API's (ORR-1137): the login it would make, made in the store.
    const {secret} = await store.startLogin(person, key)
    return {cookie: `orrery_login_9000=${secret}`}
}

beforeEach(async () => {
    ({store} = await storeSetup())
    config = {auth: 'on', oidc: {issuer: '', clientId: '', clientSecret: ''}, listenHost: '', phoneListen: String(PHONE_PORT)}
    cookies = []
    clearSignInLinks()
    const fail = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('getRequestHost', (event: Event) => event.headers.host)
    vi.stubGlobal('getCookie', (event: Event, name: string) => new RegExp(`${name}=([^;]+)`).exec(event.headers.cookie ?? '')?.[1])
    vi.stubGlobal('setCookie', (_: Event, name: string, value: string, options: Record<string, unknown>) => cookies.push({name, value, options}))
    vi.stubGlobal('deleteCookie', () => undefined)
    vi.stubGlobal('getRequestProtocol', () => 'http')
    vi.stubGlobal('getRequestURL', () => new URL('http://localhost:9000/api/phone/link'))
    vi.stubGlobal('createError', (input: {statusCode: number, message: string}) => Object.assign(new Error(input.message), input))
    vi.stubGlobal('sessionName', (name: string | undefined) => name)
    vi.stubGlobal('readBody', async (event: Event) => event.body)
    vi.stubGlobal('setResponseStatus', (event: Event, status: number) => event.status = status)
    vi.stubGlobal('conflict', fail(409))
    vi.stubGlobal('badRequest', fail(400))
    vi.stubGlobal('forbidden', fail(403))
    vi.resetModules()
    vi.stubGlobal('actorOf', (await import('../server/utils/actor')).actorOf)
    vi.stubGlobal('chatWrite', (await import('../server/utils/chats')).chatWrite)
    vi.stubGlobal('untrustedWrite', (await import('../server/utils/untrusted')).untrustedWrite)
    const auth = await import('../server/utils/auth')
    for (const name of ['logIn', 'authMode', 'canGetIn', 'overHttps', 'LOGIN_COOKIE', 'loginCookie'] as const) vi.stubGlobal(name, auth[name])
    vi.stubGlobal('oidcOn', (await import('../server/utils/oidc')).oidcOn)
    const {authorize, memberAsking} = await import('../server/utils/authorize')
    vi.stubGlobal('authorize', authorize)
    vi.stubGlobal('memberAsking', memberAsking)
    vi.stubGlobal('refusedFor', (await import('../server/utils/permission')).refusedFor)
    vi.stubGlobal('viaPhone', (await import('../server/utils/phone-port')).viaPhone)
    const links = await import('../server/utils/phone-sign-in')
    vi.stubGlobal('makeSignInLink', links.makeSignInLink)
    vi.stubGlobal('takeSignInLink', links.takeSignInLink)
    vi.stubGlobal('takeSignInCode', links.takeSignInCode)
    gate = (await import('../server/middleware/auth')).default as unknown as Route
    await store.nameOwner({name: 'Skoll'})
    await store.addPerson({name: 'Hati'})
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** A sign-in link the owner's own page made, with login off, and its code. */
async function ownersLinkAndCode() {
    config.auth = 'off'
    const {data} = await makeLink({headers: named('skoll')})
    config.auth = 'on'
    return data as {token: string, code: string}
}
const ownersLink = async () => (await ownersLinkAndCode()).token

describe('POST /api/phone/link', () => {
    describe('with login off, from this machine', () => {
        beforeEach(() => {
            config.auth = 'off'
        })

        it("makes the owner's page a one-time link, good for a few minutes", async () => {
            const {data, status} = await makeLink({headers: named('skoll')})
            expect(status).toBe(201)
            const {token, expires_at} = data as {token: string, expires_at: string}
            expect(token).toMatch(/^[\w-]{32,}$/)
            expect(new Date(expires_at).getTime() - Date.now()).toBeGreaterThan((LINK_MINUTES - 1) * 60_000)
        })

        it.each([
            ['a session', named('claude')],
            ['a session naming no one', {} as Record<string, string>],
            ['a member by name', named('hati')],
            ["the owner's chat naming the owner", named('skoll', {'orrery-chat': 'yes'})],
            ['an untrusted session naming the owner', named('skoll', {'orrery-untrusted': 'yes'})],
        ])('refuses %s', async (_, headers) => {
            expect((await failure(() => makeLink({headers}))).status).toBe(403)
        })

        it('asks for an owner first, while nobody is named', async () => {
            ({store} = await storeSetup())
            // The page before its first question, under the name an unnamed owner goes by.
            const {name} = await store.ownerOf()
            expect((await failure(() => makeLink({headers: named(name)}))).status).toBe(409)
        })
    })

    describe('with login on', () => {
        beforeEach(async () => {
            // Claimed, as a server anyone could log in to is.
            await store.makeKey('skoll', {kind: 'person', name: 'claim'})
        })

        it("makes one for the owner's own browser", async () => {
            expect((await makeLink({headers: await browser('skoll')})).status).toBe(201)
        })

        it("refuses an agent key, the owner's own included", async () => {
            for (const person of ['skoll', 'hati']) {
                const {key} = await store.makeKey(person, {kind: 'agent', name: 'desk'})
                expect((await failure(() => makeLink({headers: bearer(key)}))).status).toBe(403)
                expect((await failure(() => makeLink({headers: {...bearer(key), 'orrery-chat': 'yes'}}))).status).toBe(403)
            }
        })

        it('refuses another person in their own browser', async () => {
            const hati = await browser('hati')
            expect((await failure(() => makeLink({headers: hati}))).status).toBe(403)
        })

        it("refuses the owner's person key sent as a bearer, which isn't their browser", async () => {
            const {key} = await store.makeKey('skoll', {kind: 'person', name: 'spare'})
            expect((await failure(() => makeLink({headers: bearer(key)}))).status).toBe(401)
        })
    })

    it("refuses over the phone's port, even for the owner's phone, so a phone can't hand out more", async () => {
        await store.makeKey('skoll', {kind: 'person', name: 'claim'})
        const phone = await browser('skoll')
        expect((await failure(() => makeLink({headers: phone, phone: true}))).status).toBe(403)
        // ORRERY_AUTH=off doesn't open the phone's port: it closes it.
        config.auth = 'off'
        expect((await failure(() => makeLink({headers: named('skoll'), phone: true}))).status).toBe(503)
    })
})

describe('POST /api/auth/link', () => {
    it("signs the phone in as the owner, with a login of its own named so", async () => {
        const token = await ownersLink()
        const {data, status} = await useLink(token, {phone: true})
        expect(status).toBe(201)
        expect(data).toEqual({person: 'skoll'})
        const cookie = cookies.at(-1)!
        expect(cookie).toMatchObject({name: 'orrery_login_9000', options: {httpOnly: true, sameSite: 'lax'}})
        const logins = await store.logins('skoll')
        expect(logins.find(l => l.name === PHONE_LOGIN)).toBeDefined()
        expect(await store.loginHolder(cookie.value)).toMatchObject({person: 'skoll'})
    })

    it('refuses the same link a second time', async () => {
        const token = await ownersLink()
        await useLink(token, {phone: true})
        expect((await failure(() => useLink(token, {phone: true}))).status).toBe(401)
    })

    it('refuses a link that has run out', async () => {
        vi.useFakeTimers({toFake: ['Date']})
        const token = await ownersLink()
        vi.setSystemTime(Date.now() + LINK_MINUTES * 60_000 + 1)
        expect((await failure(() => useLink(token, {phone: true}))).status).toBe(401)
    })

    it('refuses one never made, or no token at all', async () => {
        for (const token of ['x'.repeat(43), '', undefined, {token: 1}]) {
            expect((await failure(() => useLink(token, {phone: true}))).status).toBe(401)
        }
        expect(cookies).toEqual([])
    })
})

describe('POST /api/auth/link with a typed code (ORR-875)', () => {
    it("signs the phone in as the owner, on a login of its own, and uses up the QR's link", async () => {
        const {token, code} = await ownersLinkAndCode()
        const {data, status} = await useCode(code.toLowerCase(), {phone: true})
        expect(status).toBe(201)
        expect(data).toEqual({person: 'skoll'})
        expect((await store.logins('skoll')).find(l => l.name === PHONE_LOGIN)).toBeDefined()
        expect((await failure(() => useLink(token, {phone: true}))).status).toBe(401)
        expect((await failure(() => useCode(code, {phone: true}))).status).toBe(401)
    })

    it('refuses a wrong code, saying where to look, and sets no cookie', async () => {
        await ownersLinkAndCode()
        const refused = await failure(() => useCode('ZZZZZZ', {phone: true}))
        expect(refused.status).toBe(401)
        expect(refused.message).toMatch(/App settings/)
        expect(cookies).toEqual([])
    })
})

describe("over the phone's port, nothing is this machine (ORR-837)", () => {
    beforeEach(async () => {
        await store.makeKey('skoll', {kind: 'person', name: 'claim'})
    })

    it('even with Host: localhost and a loopback connection', async () => {
        const {fromThisMachine} = await import('../server/utils/this-machine')
        expect(fromThisMachine(request('/', {phone: true}) as never)).toBe(false)
        expect(fromThisMachine(request('/', {}) as never)).toBe(true)
    })
})
