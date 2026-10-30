import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {exportJWK, generateKeyPair, SignJWT} from 'jose'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

// Logging in through a provider (ORR-697): the checks that decide who someone is, with a small provider on this machine
// signing real tokens with keys of its own. If one of them broke everyone could still log in, so only a test would notice.
// Nitro's auto-imports are stood in for here, with events standing in for requests.
const CLIENT = 'orrery-client'
const SECRET = 'client-secret'
const ORRERY = 'http://orrery.test'
type Claims = {iss?: string, aud?: string, sub?: string, nonce?: string}
type Event = {path: string, query: Record<string, string>, cookies: Record<string, string>, set: Record<string, {value: string, options: Record<string, unknown>}>, gone: string[]}

type Token = {claims?: Claims, key?: CryptoKey, none?: boolean}
type Issued = {nonce: string, token?: Token}

/** A provider: its discovery document (which `discovery` can change), its keys, and a token endpoint that signs what the
 * test says, for the nonce the login asked with unless the test says otherwise. It remembers what it was sent. */
async function standInProvider() {
    const {privateKey, publicKey} = await generateKeyPair('RS256')
    const jwk = {...await exportJWK(publicKey), kid: 'one', alg: 'RS256', use: 'sig'}
    const issued: Issued = {nonce: ''}
    const posts: URLSearchParams[] = []
    let discovery: Record<string, unknown> = {}
    const server = createServer(async (req, res) => {
        const json = (body: unknown) => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(body))
        if (req.url === '/.well-known/openid-configuration') return json({issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, jwks_uri: `${url}/jwks`, ...discovery})
        if (req.url === '/jwks') return json({keys: [jwk]})
        let body = ''
        for await (const chunk of req) body += chunk
        posts.push(new URLSearchParams(body))
        if (issued.token?.none) return json({access_token: 'only-this'})
        const claims = {iss: url, aud: CLIENT, sub: 'account-1', nonce: issued.nonce, ...issued.token?.claims}
        const signing = new SignJWT({nonce: claims.nonce}).setProtectedHeader({alg: 'RS256', kid: 'one'}).setIssuedAt().setExpirationTime('5m').setIssuer(claims.iss).setAudience(claims.aud)
        if (claims.sub) signing.setSubject(claims.sub)
        json({id_token: await signing.sign(issued.token?.key ?? privateKey)})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
        url, issued, posts,
        discover: (document: Record<string, unknown>) => discovery = document,
        close: () => {
            server.closeAllConnections()
            server.close()
        },
    }
}

let provider: Awaited<ReturnType<typeof standInProvider>>
let store: StoreType
let config: {auth: string, listenHost: string, oidc: {issuer: string, clientId: string, clientSecret: string}}
let startOidc: typeof import('../server/utils/oidc').startOidc
let finishOidc: typeof import('../server/utils/oidc').finishOidc
let requests: string[]

const request = (query: Record<string, string> = {}, cookies: Record<string, string> = {}): Event => ({path: '/api/auth/oidc/x', query, cookies, set: {}, gone: []})

/** A browser starting a login: the provider's URL it's sent to, and the cookie it holds. */
async function started(invite?: string) {
    const event = request()
    const url = new URL(await startOidc(event as never, invite))
    provider.issued.nonce = url.searchParams.get('nonce')!
    return {url, event, cookie: event.set.orrery_oidc!, state: url.searchParams.get('state')!}
}
/** The way back, as the provider sends the browser: this browser's own cookie and state, unless a test says otherwise. */
async function back({query, cookies}: {query?: Record<string, string>, cookies?: Record<string, string>} = {}, invite?: string) {
    const {state, cookie} = await started(invite)
    return finishOidc(request(query ?? {state, code: 'a-code'}, cookies ?? {orrery_oidc: cookie.value}) as never)
}

beforeEach(async () => {
    provider = await standInProvider()
    ;({store} = await storeSetup())
    await store.nameOwner({name: 'Skoll'})
    await store.addPerson({name: 'Hati'})
    config = {auth: 'on', listenHost: '', oidc: {issuer: provider.url, clientId: CLIENT, clientSecret: SECRET}}
    requests = []
    const error = (input: {statusCode: number, statusMessage?: string, message?: string}) => Object.assign(new Error(input.message ?? input.statusMessage), input)
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('createError', error)
    vi.stubGlobal('notFound', (message: string) => error({statusCode: 404, message}))
    vi.stubGlobal('getQuery', (event: Event) => event.query)
    vi.stubGlobal('getCookie', (event: Event, name: string) => event.cookies[name])
    vi.stubGlobal('setCookie', (event: Event, name: string, value: string, options: Record<string, unknown>) => event.set[name] = {value, options})
    vi.stubGlobal('deleteCookie', (event: Event, name: string) => event.gone.push(name))
    vi.stubGlobal('getRequestURL', () => new URL(`${ORRERY}/api/auth/oidc/x`))
    vi.stubGlobal('getRequestProtocol', () => 'http')
    vi.stubGlobal('sendRedirect', (_: Event, to: string) => ({redirect: to}))
    vi.stubGlobal('$fetch', async (url: string, options?: RequestInit) => {
        requests.push(url)
        const response = await fetch(url, options)
        if (!response.ok) throw error({statusCode: response.status})
        return response.json()
    })
    vi.resetModules()
    const oidc = await import('../server/utils/oidc')
    ;({startOidc, finishOidc} = oidc)
    vi.stubGlobal('oidcOn', oidc.oidcOn)
    vi.stubGlobal('startOidc', oidc.startOidc)
    vi.stubGlobal('finishOidc', oidc.finishOidc)
    vi.stubGlobal('logIn', (await import('../server/utils/auth')).logIn)
})

afterEach(() => {
    provider.close()
    vi.unstubAllGlobals()
})

describe('starting a login', () => {
    it('sends PKCE with S256, and a state and nonce of its own each time', async () => {
        const {url, cookie} = await started()
        expect(`${url.origin}${url.pathname}`).toBe(`${provider.url}/authorize`)
        const asked = Object.fromEntries(url.searchParams)
        expect(asked).toMatchObject({response_type: 'code', scope: 'openid', client_id: CLIENT, redirect_uri: `${ORRERY}/api/auth/oidc/callback`, code_challenge_method: 'S256'})
        const {verifier, state, nonce} = JSON.parse(Buffer.from(cookie.value, 'base64url').toString())
        expect(asked.code_challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
        expect([asked.state, asked.nonce]).toEqual([state, nonce])
        // The verifier stays in the browser's cookie, and off the address.
        expect(url.toString()).not.toContain(verifier)
        const {url: next} = await started()
        expect(next.searchParams.get('state')).not.toBe(asked.state)
        expect(next.searchParams.get('nonce')).not.toBe(asked.nonce)
    })

    it('keeps what the way back must match in a short http-only cookie, for its own routes alone', async () => {
        const {cookie} = await started()
        expect(cookie.options).toEqual({httpOnly: true, sameSite: 'lax', path: '/api/auth/oidc', maxAge: 600, secure: false})
    })
})

describe('the way back', () => {
    it('says who the provider vouches for, sending the secret and the verifier for the code', async () => {
        const {state, cookie} = await started()
        const event = request({state, code: 'a-code'}, {orrery_oidc: cookie.value})
        expect(await finishOidc(event as never)).toEqual({issuer: provider.url, subject: 'account-1'})
        const {verifier} = JSON.parse(Buffer.from(cookie.value, 'base64url').toString())
        expect(Object.fromEntries(provider.posts[0]!)).toEqual({grant_type: 'authorization_code', code: 'a-code', redirect_uri: `${ORRERY}/api/auth/oidc/callback`, client_id: CLIENT, client_secret: SECRET, code_verifier: verifier})
        // Good once: the cookie goes, whatever comes of it.
        expect(event.gone).toEqual(['orrery_oidc'])
    })

    it('carries the invite through its cookie', async () => {
        expect(await back({}, 'the-invite')).toEqual({issuer: provider.url, subject: 'account-1', invite: 'the-invite'})
    })

    it.each<[string, Token]>([
        ['a wrong nonce', {claims: {nonce: 'another-browsers'}}],
        ['a wrong audience', {claims: {aud: 'another-client'}}],
        ['a wrong issuer', {claims: {iss: 'https://other.example'}}],
        ['no subject', {claims: {sub: ''}}],
        ['no ID token', {none: true}],
    ])('refuses a token with %s', async (_, token) => {
        provider.issued.token = token
        expect((await failure(() => back())).status).toBe(401)
    })

    it('refuses a token signed by another key', async () => {
        provider.issued.token = {key: (await generateKeyPair('RS256')).privateKey}
        expect((await failure(() => back())).status).toBe(401)
    })

    it('refuses a missing cookie, before asking the provider anything', async () => {
        expect((await failure(() => back({cookies: {}}))).status).toBe(401)
        expect(provider.posts).toEqual([])
    })

    it.each(['not json at all', 'null', '"a string"'])('refuses a cookie that is %s, as a browser can send anything', async text => {
        const {state} = await started()
        const cookies = {orrery_oidc: Buffer.from(text).toString('base64url')}
        expect((await failure(() => finishOidc(request({state, code: 'a-code'}, cookies) as never))).status).toBe(401)
        expect(provider.posts).toEqual([])
    })

    it("refuses another browser's state, or none, or no code, before asking the provider anything", async () => {
        const {state, cookie} = await started()
        for (const query of [{state: 'someone-elses', code: 'a-code'}, {code: 'a-code'}, {state}]) {
            expect((await failure(() => finishOidc(request(query as Record<string, string>, {orrery_oidc: cookie.value}) as never))).status).toBe(401)
        }
        expect(provider.posts).toEqual([])
    })
})

describe("the provider's address", () => {
    it.each(['http://id.example', 'http://127.0.0.1.id.example', 'http://localhost.id.example'])('refuses %s on plain http, before asking it anything', async issuer => {
        config.oidc.issuer = issuer
        expect((await failure(() => startOidc(request() as never))).status).toBe(500)
        expect(requests).toEqual([])
    })

    it.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri'])('refuses a discovery document with %s on plain http off this machine', async endpoint => {
        provider.discover({[endpoint]: 'http://id.example/somewhere'})
        expect((await failure(() => startOidc(request() as never))).status).toBe(500)
    })

    it('answers 502 to a discovery document naming another issuer', async () => {
        provider.discover({issuer: 'https://other.example'})
        expect((await failure(() => startOidc(request() as never))).status).toBe(502)
    })

    it('gives a provider that writes its issuer with a trailing slash the same one, so a moved login is found', async () => {
        provider.discover({issuer: `${provider.url}/`})
        provider.issued.token = {claims: {iss: `${provider.url}/`}}
        expect(await back()).toEqual({issuer: provider.url, subject: 'account-1'})
    })

    it('takes an issuer set with a trailing slash as the same one', async () => {
        config.oidc.issuer = `${provider.url}/`
        expect(await back()).toEqual({issuer: provider.url, subject: 'account-1'})
    })
})

describe('the routes', () => {
    const route = async (load: Promise<{default: unknown}>) => (await load).default as (event: Event) => Promise<{redirect: string}>
    const start = (event: Event) => route(import('../server/api/auth/oidc/start.get')).then(handler => handler(event))
    const callback = (event: Event) => route(import('../server/api/auth/oidc/callback.get')).then(handler => handler(event))

    /** Through both, as a browser goes: to the provider with `query`, and back. */
    async function login(query: Record<string, string> = {}) {
        const going = request(query)
        const {redirect} = await start(going)
        const url = new URL(redirect)
        provider.issued.nonce = url.searchParams.get('nonce')!
        const coming = request({state: url.searchParams.get('state')!, code: 'a-code'}, {orrery_oidc: going.set.orrery_oidc!.value})
        return {event: coming, answer: await callback(coming)}
    }

    it('answer 404 with no provider set up', async () => {
        config.oidc = {issuer: '', clientId: '', clientSecret: ''}
        expect((await failure(() => start(request()))).status).toBe(404)
        expect((await failure(() => callback(request()))).status).toBe(404)
    })

    it('give an account orrery does not know, with no invite, 403 and no login', async () => {
        const {status} = await failure(() => login())
        expect(status).toBe(403)
        expect(await store.identity(provider.url, 'account-1')).toBeUndefined()
    })

    it('attach an invited account to its person, using the invite up, and log them in', async () => {
        const {secret} = await store.invite('hati')
        const {event, answer} = await login({invite: secret})
        expect(answer).toEqual({redirect: '/'})
        expect(event.set.orrery_login!.options).toMatchObject({httpOnly: true, sameSite: 'lax', path: '/'})
        expect((await store.loginHolder(event.set.orrery_login!.value))?.person).toBe('hati')
    })

    it('log a known account in, with no invite', async () => {
        const {secret} = await store.invite('hati')
        await store.identity(provider.url, 'account-1', secret)
        const {event, answer} = await login()
        expect(answer).toEqual({redirect: '/'})
        expect((await store.loginHolder(event.set.orrery_login!.value))?.person).toBe('hati')
    })

    it('set no login when the token is refused, whatever else it says', async () => {
        const {secret} = await store.invite('hati')
        await store.identity(provider.url, 'account-1', secret)
        provider.issued.token = {claims: {aud: 'another-client'}}
        expect((await failure(() => login())).status).toBe(401)
    })
})
