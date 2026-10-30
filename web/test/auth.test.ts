import {readdirSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

// Login and keys (ORR-664): the middleware that asks every /api route for a credential, against a real store, on events
// standing in for requests. Nitro's auto-imports are stood in for here.
type Event = {path: string, method: string, headers: Record<string, string>, context: Record<string, unknown>, node: {req: unknown}}
let store: StoreType
let config: Record<string, unknown>
let noted: {kind: string, message: string}[]
let gate: (event: Event) => Promise<void>
let actorOf: typeof import('../server/utils/actor').actorOf
let personOf: typeof import('../server/utils/actor').personOf
let authMode: typeof import('../server/utils/auth').authMode

const asking = (path: string, {method = 'GET', headers = {}, bound = '127.0.0.1'}: {method?: string, headers?: Record<string, string>, bound?: string} = {}): Event => ({
    path, method, headers, context: {},
    node: {req: {headers, socket: {remoteAddress: '127.0.0.1', server: {address: () => ({address: bound})}}}},
})
const bearer = (key: string, more: Record<string, string> = {}) => ({authorization: `Bearer ${key}`, ...more})

beforeEach(async () => {
    ({store} = await storeSetup())
    config = {auth: 'on', oidc: {issuer: '', clientId: '', clientSecret: ''}, listenHost: ''}
    const fail = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('getCookie', (event: Event, name: string) => new RegExp(`${name}=([^;]+)`).exec(event.headers.cookie ?? '')?.[1])
    vi.stubGlobal('createError', (input: {statusCode: number, message: string}) => Object.assign(new Error(input.message), input))
    vi.stubGlobal('sessionName', (name: string | undefined) => name)
    vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
    vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
    vi.stubGlobal('conflict', fail(409))
    noted = []
    vi.stubGlobal('useEventLog', () => ({note: (entry: {kind: string, message: string}) => noted.push(entry)}))
    vi.resetModules()
    gate = (await import('../server/middleware/auth')).default as unknown as typeof gate
    ;({actorOf, personOf} = await import('../server/utils/actor'))
    ;({authMode} = await import('../server/utils/auth'))
    await store.nameOwner({name: 'Skoll'})
    await store.addPerson({name: 'Hati'})
})

afterEach(() => vi.unstubAllGlobals())

/** Every route under server/api, from the file tree, so a new one is covered the day it's added. */
function routes(dir = 'server/api', at = '/api'): {method: string, path: string}[] {
    return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const part = entry.name.replace(/\[[^\]]+\]/g, 'x')
        if (entry.isDirectory()) return routes(join(dir, entry.name), `${at}/${part}`)
        const [name, method] = part.split('.') as [string, string]
        return [{method: method.toUpperCase(), path: name === 'index' ? at : `${at}/${name}`}]
    })
}
const OPEN = ['/api/auth/status', '/api/auth/login', '/api/auth/logout', '/api/auth/oidc/start', '/api/auth/oidc/callback']

describe('with auth on', () => {
    let agent: string

    beforeEach(async () => {
        agent = (await store.makeKey('hati', {kind: 'agent', name: 'laptop'})).key
        await store.makeKey('skoll', {kind: 'person', name: 'claim'})
    })

    it('every route refuses a request with no credential, reads included', async () => {
        const all = routes()
        expect(all.length).toBeGreaterThan(100)
        for (const {method, path} of all) {
            if (OPEN.includes(path)) continue
            expect((await failure(() => gate(asking(path, {method})))).status, `${method} ${path}`).toBe(401)
        }
    })

    it('stays open only for the login itself, and sees through other spellings of /api', async () => {
        for (const path of OPEN) await expect(gate(asking(path))).resolves.toBeUndefined()
        for (const path of ['/%61pi/projects', '//api/projects', '/API/projects', '/api\\projects', '/api/auth/status/../../projects', '/api/%zz']) {
            expect([401], path).toContain((await failure(() => gate(asking(path)))).status)
        }
    })

    it("an agent key is an agent of its person, whatever it sends", async () => {
        const event = asking('/api/projects', {headers: bearer(agent, {'orrery-actor': 'skoll', 'orrery-person': 'skoll', 'orrery-session': 'w'})})
        await gate(event)
        expect(event.context.who).toEqual({person: 'hati', owner: false, via: 'agent'})
        expect(await actorOf(event as never)).toMatchObject({name: 'agent', owner: false})
        expect(await personOf(event as never)).toBe('hati')
        const honest = asking('/api/projects', {headers: bearer(agent, {'orrery-actor': 'claude'})})
        await gate(honest)
        expect((await actorOf(honest as never)).name).toBe('claude')
    })

    it("an agent key is held to the rails between people, whoever it says it's for", async () => {
        const issue = await store.createIssue('greenhouse', {title: "Skoll's", assignee: 'skoll'})
        const event = asking('/api/projects', {headers: bearer(agent, {'orrery-actor': 'claude', 'orrery-person': 'skoll', 'orrery-session': 'w'})})
        await gate(event)
        const actor = await actorOf(event as never)
        expect(actor).toMatchObject({asked: true, named: 'hati', owner: false})
        expect((await failure(() => store.updateIssue('greenhouse', issue.id, {status: 'done'}, actor))).status).toBe(409)
    })

    it('logs a session whose Orrery-Person disagrees with its key, once per session', async () => {
        const say = (headers: Record<string, string>) => gate(asking('/api/projects', {headers: bearer(agent, headers)}))
        await say({'orrery-person': 'hati', 'orrery-session': 'a'})
        await say({'orrery-session': 'a'})
        expect(noted).toEqual([])
        await say({'orrery-person': 'skoll', 'orrery-session': 'a'})
        await say({'orrery-person': 'skoll', 'orrery-session': 'a'})
        expect(noted).toHaveLength(1)
        expect(noted[0]).toMatchObject({kind: 'auth.person_mismatch'})
        expect(noted[0]?.message).toContain('"skoll"')
        await say({'orrery-person': 'skoll', 'orrery-session': 'b'})
        expect(noted).toHaveLength(2)
    })

    it("keeps a session with the person whose key it first reported with, and refuses another's writes as it", async () => {
        const {key: skolls} = await store.makeKey('skoll', {kind: 'agent', name: 'desk'})
        const write = (key: string, session?: string) => gate(asking('/api/projects', {method: 'POST', headers: bearer(key, session ? {'orrery-session': session} : {})}))
        await write(agent, 'window-a')
        await write(agent, 'window-a')
        const {status, message} = await failure(() => write(skolls, 'window-a'))
        expect(status).toBe(409)
        expect(message).toContain("hati's")
        // A read isn't a write, its own session is its own, and one naming no session is still that key's.
        await gate(asking('/api/projects', {headers: bearer(skolls, {'orrery-session': 'window-a'})}))
        await write(skolls, 'window-b')
        await write(skolls)
    })

    it("holds a session's person through the owner's rename", async () => {
        const {key: skolls} = await store.makeKey('skoll', {kind: 'agent', name: 'desk'})
        await gate(asking('/api/projects', {method: 'POST', headers: bearer(skolls, {'orrery-session': 'window-a'})}))
        await store.nameOwner({name: 'Sol'}, {name: 'skoll', owner: true, asked: true})
        expect(await store.fixSessionPerson('window-a', 'hati')).toBe('sol')
    })

    it("an owner's agent key is still not the owner", async () => {
        const {key} = await store.makeKey('skoll', {kind: 'agent', name: 'desk'})
        const event = asking('/api/projects', {headers: bearer(key, {'orrery-actor': 'skoll'})})
        await gate(event)
        expect((await actorOf(event as never)).owner).toBe(false)
        expect(await personOf(event as never)).toBe('skoll')
    })

    it('a person key is no bearer, only a way to log in', async () => {
        const {key} = await store.makeKey('skoll', {kind: 'person', name: 'spare'})
        expect((await failure(() => gate(asking('/api/projects', {headers: bearer(key)})))).status).toBe(401)
    })

    it('a revoked key, and a removed person’s, stop at once', async () => {
        const made = await store.makeKey('hati', {kind: 'agent', name: 'other'})
        await gate(asking('/api/projects', {headers: bearer(made.key)}))
        await store.revokeKey(made.id)
        expect((await failure(() => gate(asking('/api/projects', {headers: bearer(made.key)})))).status).toBe(401)
        const {secret} = await store.startLogin('hati')
        await gate(asking('/api/projects', {headers: bearer(agent)}))
        await store.removePerson('hati', {name: 'skoll', owner: true})
        expect((await failure(() => gate(asking('/api/projects', {headers: bearer(agent)})))).status).toBe(401)
        expect((await failure(() => gate(asking('/api/projects', {headers: {cookie: `orrery_login=${secret}`}})))).status).toBe(401)
    })

    it('a login is its person, and its writes have to come from a page', async () => {
        const {secret} = await store.startLogin('skoll')
        const cookie = `orrery_login=${secret}`
        const read = asking('/api/projects', {headers: {cookie, 'orrery-actor': 'someone'}})
        await gate(read)
        expect(await actorOf(read as never)).toEqual({name: 'skoll', owner: true, asked: true, named: 'skoll'})
        expect((await failure(() => gate(asking('/api/projects', {method: 'POST', headers: {cookie}})))).status).toBe(403)
        await expect(gate(asking('/api/projects', {method: 'POST', headers: {cookie, origin: 'http://localhost:9000'}}))).resolves.toBeUndefined()
        await store.endLogin(secret)
        expect((await failure(() => gate(asking('/api/projects', {headers: {cookie}})))).status).toBe(401)
    })

    it('answers 503 while nobody can get in, rather than opening', async () => {
        const [claim] = (await store.keys('skoll')).filter(k => k.kind === 'person')
        await store.revokeKey(claim!.id)
        const {status, message} = await failure(() => gate(asking('/api/projects')))
        expect(status).toBe(503)
        expect(message).toContain('orrery:claim')
    })
})

describe('when it is on', () => {
    const off = async (event = asking('/api/projects')) => authMode(event as never)

    it('stays off for one person on loopback, whatever they send', async () => {
        const {store: alone} = await storeSetup()
        await alone.nameOwner({name: 'Solo'})
        vi.stubGlobal('useStore', () => alone)
        config.auth = ''
        expect(await off()).toBe('off')
        const event = asking('/api/projects', {headers: {'orrery-actor': 'solo'}})
        await gate(event)
        expect(event.context.who).toBeUndefined()
        expect(await actorOf(event as never)).toMatchObject({name: 'solo', owner: true})
    })

    it('comes on with a second person, and stays on once they go', async () => {
        config.auth = ''
        expect(await off()).toBe('on')
        await store.removePerson('hati', {name: 'skoll', owner: true})
        expect(await off()).toBe('on')
    })

    it("comes on off loopback, and for a proxy's request alone", async () => {
        const {store: alone} = await storeSetup()
        await alone.nameOwner({name: 'Solo'})
        vi.stubGlobal('useStore', () => alone)
        config.auth = ''
        expect(await off(asking('/api/projects', {bound: '0.0.0.0'}))).toBe('on')
        expect(await off(asking('/api/projects', {bound: '::'}))).toBe('on')
        expect(await off(asking('/api/projects', {headers: {'x-forwarded-for': '1.2.3.4'}}))).toBe('on')
        expect(await off()).toBe('off')
    })

    it('ORRERY_AUTH=off overrules a second person on loopback, and refuses to serve anywhere else', async () => {
        config.auth = 'off'
        expect(await off()).toBe('off')
        const event = asking('/api/projects', {bound: '0.0.0.0'})
        expect(await off(event)).toBe('closed')
        expect((await failure(() => gate(event))).status).toBe(503)
    })

    it('a database that can’t say counts as on', async () => {
        vi.stubGlobal('useStore', () => ({authStaysOn: () => Promise.reject(new Error('gone'))}))
        config.auth = ''
        expect(await off()).toBe('on')
    })
})

describe('adding a second person', () => {
    let needsWayInForPeople: typeof import('../server/utils/auth').needsWayInForPeople

    beforeEach(async () => {
        ({needsWayInForPeople} = await import('../server/utils/auth'))
        config.auth = ''
    })

    it('waits until someone could log in, unless only trying it out', async () => {
        const {status, message} = await failure(() => needsWayInForPeople())
        expect(status).toBe(409)
        expect(message).toContain('orrery:claim')
        await store.makeKey('skoll', {kind: 'person', name: 'claim'})
        await expect(needsWayInForPeople()).resolves.toBeUndefined()
        await store.db.run('UPDATE keys SET revoked_at = ?', 'now')
        config.auth = 'off'
        await expect(needsWayInForPeople()).resolves.toBeUndefined()
    })
})

describe('keys', () => {
    it('keeps only a hash, and never lists the secret', async () => {
        const made = await store.makeKey('hati', {kind: 'agent', name: 'laptop'})
        expect(made.key).toMatch(/^orrery_agent_/)
        expect(JSON.stringify(await store.db.all('SELECT * FROM keys'))).not.toContain(made.key)
        expect((await store.keys('hati'))[0]).not.toHaveProperty('key')
        expect(await store.keyHolder(made.key)).toEqual({person: 'hati', owner: false, kind: 'agent'})
        expect(await store.keyHolder(`${made.key}x`)).toBeUndefined()
    })

    it('asks what kind and what for, and of someone here', async () => {
        expect((await failure(() => store.makeKey('hati', {kind: 'root', name: 'x'}))).status).toBe(400)
        expect((await failure(() => store.makeKey('hati', {kind: 'agent', name: ' '}))).status).toBe(400)
        expect((await failure(() => store.makeKey('owner', {kind: 'agent', name: 'x'}))).status).toBe(404)
    })

    it("only touches someone else's key for the owner", async () => {
        const {id} = await store.makeKey('skoll', {kind: 'agent', name: 'desk'})
        expect((await failure(() => store.revokeKey(id, 'hati'))).status).toBe(404)
        await store.revokeKey(id, 'skoll')
        expect((await store.keys('skoll'))[0]?.revoked_at).toBeTruthy()
    })

    it("follow the owner through a rename", async () => {
        const {key} = await store.makeKey('skoll', {kind: 'person', name: 'claim'})
        await store.nameOwner({name: 'Maanegarm'}, {name: 'skoll', owner: true})
        expect((await store.keyHolder(key))?.person).toBe('maanegarm')
    })
})

describe('identities', () => {
    it('attaches by an invite once, and then by issuer and subject', async () => {
        const {secret} = await store.invite('hati')
        expect(await store.identity('https://id.example', 'sub-1')).toBeUndefined()
        expect(await store.identity('https://id.example', 'sub-1', secret)).toBe('hati')
        expect(await store.identity('https://id.example', 'sub-1')).toBe('hati')
        expect(await store.identity('https://other.example', 'sub-1')).toBeUndefined()
        expect((await failure(() => store.identity('https://id.example', 'sub-2', secret))).status).toBe(409)
    })

    it("an invite that's run out attaches nobody", async () => {
        const {secret} = await store.invite('hati')
        await store.db.run("UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z'")
        expect((await failure(() => store.identity('https://id.example', 'sub-1', secret))).status).toBe(409)
    })

    it('a removed person’s account gets in no more', async () => {
        const {secret} = await store.invite('hati')
        await store.identity('https://id.example', 'sub-1', secret)
        await store.removePerson('hati', {name: 'skoll', owner: true})
        expect(await store.identity('https://id.example', 'sub-1')).toBeUndefined()
    })
})
