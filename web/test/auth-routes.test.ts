import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

// Who may make, list and revoke keys, log in and invite (ORR-696). These rules live in the routes, not the store: only a
// person handles keys, never a session, so an agent can't make itself a person key and act as its person. Each request
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
        path, method, headers, context: {}, body, params: key ? {key} : {},
        node: {req: {headers, socket: {remoteAddress: '127.0.0.1', server: {address: () => ({address: '127.0.0.1'})}}}},
    }
    await gate(event)
    const route = (await load()).default as Route
    return {data: await route(event), status: event.status ?? 200}
}
const makeKey = (headers: Record<string, string>, body: Record<string, unknown>) => ask(() => import('../server/api/keys/index.post'), '/api/keys', {method: 'POST', headers, body})
const listKeys = (headers: Record<string, string>) => ask(() => import('../server/api/keys/index.get'), '/api/keys', {headers})
const revokeKey = (headers: Record<string, string>, key: string) => ask(() => import('../server/api/keys/[key].delete'), `/api/keys/${key}`, {method: 'DELETE', headers, key})
const invite = (headers: Record<string, string>, person = 'hati') => ask(() => import('../server/api/invites/index.post'), '/api/invites', {method: 'POST', headers, body: {person}})
const logIn = (key: unknown) => ask(() => import('../server/api/auth/login.post'), '/api/auth/login', {method: 'POST', body: {key}})

/** A person's browser: logged in with a person key, as the page is, its writes saying they come from a page. */
async function browser(person: string) {
    const {key} = await store.makeKey(person, {kind: 'person', name: 'browser'})
    await logIn(key)
    return {cookie: `orrery_login=${cookies.at(-1)!.value}`, ...ORIGIN}
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
    vi.stubGlobal('oidcOn', (await import('../server/utils/oidc')).oidcOn)
    const {authorize, memberAsking} = await import('../server/utils/authorize')
    vi.stubGlobal('authorize', authorize)
    vi.stubGlobal('memberAsking', memberAsking)
    vi.stubGlobal('refusedFor', (await import('../server/utils/permission')).refusedFor)
    vi.stubGlobal('keyHolderOf', (await import('../server/utils/key-rights')).keyHolderOf)
    gate = (await import('../server/middleware/auth')).default as unknown as Route
    await store.nameOwner({name: 'Skoll'})
    await store.addPerson({name: 'Hati'})
    // A claimed server, as anyone could log in to: one nobody can answers 503, not 401.
    await store.makeKey('skoll', {kind: 'person', name: 'claim'})
})

afterEach(() => vi.unstubAllGlobals())

describe('with auth on, the key routes', () => {
    it.each(['skoll', 'hati'])("refuse %s's agent key, on all three", async person => {
        const {key, id} = await store.makeKey(person, {kind: 'agent', name: 'laptop'})
        // What it would want most: a person key for itself, or for its person by name.
        for (const body of [{kind: 'person', name: 'mine'}, {kind: 'person', name: 'mine', person}]) {
            expect((await failure(() => makeKey(bearer(key), body))).status).toBe(403)
        }
        expect((await failure(() => listKeys(bearer(key)))).status).toBe(403)
        expect((await failure(() => revokeKey(bearer(key), id))).status).toBe(403)
        expect((await store.keys(person)).map(k => k.name)).not.toContain('mine')
        expect((await store.keyHolder(key))?.kind).toBe('agent')
    })

    it('refuse a person key as a bearer, which only swaps for a cookie', async () => {
        const {key} = await store.makeKey('skoll', {kind: 'person', name: 'spare'})
        expect((await failure(() => listKeys(bearer(key)))).status).toBe(401)
    })

    it('let a member make, list and revoke their own', async () => {
        const hati = await browser('hati')
        const made = await makeKey(hati, {kind: 'agent', name: 'laptop'})
        expect(made.status).toBe(201)
        expect(made.data).toMatchObject({person: 'hati', kind: 'agent', key: expect.stringMatching(/^orrery_agent_/)})
        const {data: mine} = await listKeys(hati) as {data: {id: string, person: string, key?: string}[]}
        expect(mine.map(k => k.person)).toEqual(['hati', 'hati'])
        expect(mine.every(k => k.key === undefined)).toBe(true)
        expect((await revokeKey(hati, (made.data as {id: string}).id)).status).toBe(204)
        expect(await store.keyHolder((made.data as {key: string}).key)).toBeUndefined()
    })

    it("refuse a member making a key for someone else, or seeing or revoking someone else's", async () => {
        const skolls = await store.makeKey('skoll', {kind: 'agent', name: 'desk'})
        const hati = await browser('hati')
        expect((await failure(() => makeKey(hati, {kind: 'person', name: 'theirs', person: 'skoll'}))).status).toBe(403)
        expect((await listKeys(hati)).data).not.toContainEqual(expect.objectContaining({person: 'skoll'}))
        expect((await failure(() => revokeKey(hati, skolls.id))).status).toBe(404)
        expect((await store.keyHolder(skolls.key))?.person).toBe('skoll')
    })

    it("let the owner make anyone's, see everyone's and revoke anyone's", async () => {
        const skoll = await browser('skoll')
        const given = await makeKey(skoll, {kind: 'person', name: 'for hati', person: 'hati'})
        expect(given.status).toBe(201)
        expect(given.data).toMatchObject({person: 'hati', kind: 'person'})
        const people = ((await listKeys(skoll)).data as {person: string}[]).map(k => k.person)
        expect(people).toEqual(expect.arrayContaining(['skoll', 'hati']))
        expect((await revokeKey(skoll, (given.data as {id: string}).id)).status).toBe(204)
        expect(await store.keyHolder((given.data as {key: string}).key)).toBeUndefined()
    })
})

describe('with auth off, the key routes', () => {
    beforeEach(() => {
        config.auth = 'off'
    })
    const named = (name: string, more: Record<string, string> = {}) => ({'orrery-actor': name, ...more})

    it('let the owner by name handle them', async () => {
        const made = await makeKey(named('skoll'), {kind: 'person', name: 'mine'})
        expect(made.status).toBe(201)
        expect((await listKeys(named('skoll'))).data).toContainEqual(expect.objectContaining({person: 'skoll'}))
        expect((await revokeKey(named('skoll'), (made.data as {id: string}).id)).status).toBe(204)
    })

    it.each([
        ['a session', named('claude')],
        ['a session naming no one', {} as Record<string, string>],
        ['a member by name', named('hati')],
        ["the owner's chat naming the owner", named('skoll', {'orrery-chat': 'yes'})],
        ['an untrusted session naming the owner', named('skoll', {'orrery-untrusted': 'yes'})],
    ])('refuse %s', async (_, headers) => {
        const {id} = await store.makeKey('skoll', {kind: 'agent', name: 'desk'})
        expect((await failure(() => makeKey(headers, {kind: 'person', name: 'mine', person: 'skoll'}))).status).toBe(403)
        expect((await failure(() => listKeys(headers))).status).toBe(403)
        expect((await failure(() => revokeKey(headers, id))).status).toBe(403)
    })
})

describe('POST /api/auth/login', () => {
    it('swaps a person key for an http-only cookie', async () => {
        const {key} = await store.makeKey('hati', {kind: 'person', name: 'browser'})
        expect((await logIn(` ${key} `)).data).toEqual({person: 'hati'})
        expect(cookies).toHaveLength(1)
        expect(cookies[0]).toMatchObject({name: 'orrery_login', options: {httpOnly: true, sameSite: 'lax', path: '/'}})
        expect((await store.loginHolder(cookies[0]!.value))?.person).toBe('hati')
    })

    it('refuses an agent key, a wrong key and no key at all', async () => {
        const {key} = await store.makeKey('skoll', {kind: 'agent', name: 'desk'})
        for (const tried of [key, 'orrery_person_wrong', '', 42, undefined]) {
            expect((await failure(() => logIn(tried))).status).toBe(401)
        }
        expect(cookies).toEqual([])
    })

    it('refuses a revoked key', async () => {
        const {key, id} = await store.makeKey('hati', {kind: 'person', name: 'browser'})
        await store.revokeKey(id)
        expect((await failure(() => logIn(key))).status).toBe(401)
        expect(cookies).toEqual([])
    })

    it("refuses a removed person's key, and ends their login", async () => {
        const {key} = await store.makeKey('hati', {kind: 'person', name: 'browser'})
        const hati = await browser('hati')
        await store.removePerson('hati', {name: 'skoll', owner: true})
        expect((await failure(() => logIn(key))).status).toBe(401)
        expect((await failure(() => listKeys(hati))).status).toBe(401)
    })
})

describe('POST /api/auth/logout', () => {
    it('ends the login on the server, so the same cookie no longer works', async () => {
        const hati = await browser('hati')
        expect((await listKeys(hati)).status).toBe(200)
        expect((await ask(() => import('../server/api/auth/logout.post'), '/api/auth/logout', {method: 'POST', headers: hati})).status).toBe(204)
        expect(removed).toEqual(['orrery_login'])
        expect((await failure(() => listKeys(hati))).status).toBe(401)
    })
})

describe('POST /api/invites', () => {
    const provider = () => config.oidc = {issuer: 'https://id.example', clientId: 'orrery', clientSecret: 'shh'}

    it('answers 409 with no provider set up, even for the owner', async () => {
        const skoll = await browser('skoll')
        expect((await failure(() => invite(skoll))).status).toBe(409)
    })

    it("gives the owner a link, with a provider", async () => {
        provider()
        const {data, status} = await invite(await browser('skoll'))
        expect(status).toBe(201)
        expect((data as {url: string}).url).toMatch(/^http:\/\/localhost:9000\/login\?invite=/)
    })

    it("is the owner's alone: not a member's, nor an agent key's, the owner's included", async () => {
        provider()
        const hati = await browser('hati')
        const {key} = await store.makeKey('skoll', {kind: 'agent', name: 'desk'})
        expect((await failure(() => invite(hati))).status).toBe(403)
        expect((await failure(() => invite(bearer(key)))).status).toBe(403)
    })

    describe('a member asking in person, for what the routes on their own session and bell let them (ORR-746)', () => {
        const clear = (headers: Record<string, string>) => ask(() => import('../server/api/notices/clear.post'), '/api/notices/clear', {method: 'POST', headers, body: {before: new Date().toISOString()}})
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

        it('lets them clear their own bell, and refuses their agent', async () => {
            expect((await clear(await browser('hati'))).data).toHaveProperty('cleared')
            const {key} = await store.makeKey('hati', {kind: 'agent', name: 'a session'})
            await expect(clear(bearer(key))).rejects.toMatchObject({statusCode: 403})
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
})
