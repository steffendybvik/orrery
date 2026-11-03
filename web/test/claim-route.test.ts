import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

// Claiming this orrery from App settings (ORR-832): only a page on this machine, while nobody has a person key, and with
// login off only the owner's. Each request goes through the real auth middleware and on to the route, against a real
// store, on events standing in for requests. Nitro's auto-imports are stood in for here.
type Event = {path: string, method: string, headers: Record<string, string>, context: Record<string, unknown>, node: {req: unknown}, body?: unknown, status?: number}
type Route = (event: Event) => Promise<unknown>
type Asked = {headers?: Record<string, string>, body?: unknown, from?: string, bound?: string}

let store: StoreType
let config: Record<string, unknown>
let gate: Route
let cookies: {name: string, value: string}[]

const PAGE = {host: 'localhost:9000', origin: 'http://localhost:9000'}

function request(path: string, method: string, {headers = {}, body, from = '127.0.0.1', bound = '127.0.0.1'}: Asked): Event {
    const all = {...PAGE, ...headers}
    return {path, method, headers: all, context: {}, body, node: {req: {headers: all, socket: {remoteAddress: from, server: {address: () => ({address: bound})}}}}}
}
async function claim(asked: Asked = {}) {
    const event = request('/api/auth/claim', 'POST', asked)
    await gate(event)
    const route = (await import('../server/api/auth/claim.post')).default as unknown as Route
    return {data: await route(event) as {person: string, person_key: {key: string}, agent_key: {key: string}}, status: event.status ?? 200}
}
async function status(asked: Asked = {}) {
    const event = request('/api/auth/status', 'GET', asked)
    await gate(event)
    const route = (await import('../server/api/auth/status.get')).default as unknown as Route
    return await route(event) as {can_claim: boolean, named: boolean}
}
const owner = {'orrery-actor': 'skoll'}

beforeEach(async () => {
    ({store} = await storeSetup())
    config = {auth: '', oidc: {issuer: '', clientId: '', clientSecret: ''}, listenHost: ''}
    cookies = []
    const fail = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('getRequestHost', (event: Event) => event.headers.host)
    vi.stubGlobal('getCookie', (event: Event, name: string) => new RegExp(`${name}=([^;]+)`).exec(event.headers.cookie ?? '')?.[1])
    vi.stubGlobal('setCookie', (_: Event, name: string, value: string) => cookies.push({name, value}))
    vi.stubGlobal('getRequestProtocol', () => 'http')
    vi.stubGlobal('createError', (input: {statusCode: number, message: string}) => Object.assign(new Error(input.message), input))
    vi.stubGlobal('sessionName', (name: string | undefined) => name)
    vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
    vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
    vi.stubGlobal('readBody', async (event: Event) => event.body)
    vi.stubGlobal('setResponseStatus', (event: Event, code: number) => event.status = code)
    vi.stubGlobal('conflict', fail(409))
    vi.stubGlobal('badRequest', fail(400))
    vi.stubGlobal('forbidden', fail(403))
    vi.stubGlobal('refusedFor', (await import('../server/utils/permission')).refusedFor)
    vi.resetModules()
    vi.stubGlobal('actorOf', (await import('../server/utils/actor')).actorOf)
    const auth = await import('../server/utils/auth')
    for (const name of ['logIn', 'authMode', 'canGetIn', 'overHttps'] as const) vi.stubGlobal(name, auth[name])
    vi.stubGlobal('oidcOn', (await import('../server/utils/oidc')).oidcOn)
    vi.stubGlobal('claimRefusal', (await import('../server/utils/claim-here')).claimRefusal)
    gate = (await import('../server/middleware/auth')).default as unknown as Route
    await store.nameOwner({name: 'Skoll'})
})

afterEach(() => vi.unstubAllGlobals())

describe('claiming from App settings', () => {
    it("hands the owner's page on this machine a person key and an agent key, and signs it in", async () => {
        expect((await status()).can_claim).toBe(true)
        const {data, status: code} = await claim({headers: owner})
        expect(code).toBe(201)
        expect(data.person).toBe('skoll')
        expect(data.person_key.key).toMatch(/^orrery_person_/)
        expect(data.agent_key.key).toMatch(/^orrery_agent_/)
        expect(await store.keyHolder(data.person_key.key)).toMatchObject({person: 'skoll', kind: 'person', owner: true})
        expect(await store.keyHolder(data.agent_key.key)).toMatchObject({person: 'skoll', kind: 'agent'})
        expect(await store.loginHolder(cookies.at(-1)!.value)).toMatchObject({person: 'skoll'})
        expect(await store.ownerHasKey()).toBe(true)
    })

    it('is refused from off the machine, and not offered there', async () => {
        for (const asked of [{from: '192.168.1.20'}, {headers: {host: 'mac.my-vpn.net:9000'}}, {headers: {'x-forwarded-for': '203.0.113.9'}}]) {
            expect((await status(asked)).can_claim).toBe(false)
            expect((await failure(() => claim({...asked, headers: {...owner, ...asked.headers}}))).status).toBe(403)
        }
        expect(await store.ownerHasKey()).toBe(false)
    })

    it('is refused once claimed, so a second claim gets nothing', async () => {
        await claim({headers: owner})
        expect((await status()).can_claim).toBe(false)
        expect((await failure(() => claim({headers: owner}))).status).toBe(409)
    })

    it("is refused to a session, whatever it names, with login off", async () => {
        for (const headers of [{'orrery-actor': 'claude'}, {...owner, 'orrery-chat': 'yes'}, {...owner, 'orrery-untrusted': 'yes'}]) {
            expect((await failure(() => claim({headers}))).status).toBe(403)
        }
        expect(await store.ownerHasKey()).toBe(false)
    })

    it('works with login on and nobody able to log in yet, where everything else is a 503', async () => {
        config.auth = 'on'
        const {data} = await claim()
        expect(data.person).toBe('skoll')
    })

    it('names the owner first when nobody has', async () => {
        ({store} = await storeSetup())
        expect((await status()).named).toBe(false)
        expect((await failure(() => claim())).status).toBe(400)
        expect((await claim({body: {name: 'Hati Fenrisson'}})).data.person).toBe('hati_fenrisson')
    })
})
