import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {storeSetup} from './store-setup'

// What's open outside /api with a login on (ORR-689): /llms.txt, /llms-full.txt and /connect/<project>.md answer anyone,
// so with no credential they say nothing about what's on this orrery. Through the real middleware and routes, against a
// real store, on events standing in for requests. Nitro's auto-imports are stood in for here.
type Event = {path: string, method: string, headers: Record<string, string>, context: Record<string, unknown>, node: {req: unknown}, params: Record<string, string>, query: Record<string, string>}
type Route = (event: Event) => Promise<string>

let store: StoreType
let config: Record<string, unknown>
let agent: string
let personal: string

// The how-to's own example of an issue id is GRE-142, so it's the listing's words that are looked for.
const ON_IT = ['greenhouse', 'prefix `', 'Skoll']

async function ask(load: () => Promise<{default: unknown}>, path: string, {headers = {}, file, query = {}}: {headers?: Record<string, string>, file?: string, query?: Record<string, string>} = {}) {
    const event: Event = {
        path, method: 'GET', headers, context: {}, params: file ? {file} : {}, query,
        node: {req: {headers, socket: {remoteAddress: '127.0.0.1', server: {address: () => ({address: '127.0.0.1'})}}}},
    }
    await ((await import('../server/middleware/auth')).default as unknown as Route)(event)
    return await ((await load()).default as Route)(event)
}
const llms = (headers?: Record<string, string>) => ask(() => import('../server/routes/llms.txt.get'), '/llms.txt', {headers})
const llmsFull = (headers?: Record<string, string>) => ask(() => import('../server/routes/llms-full.txt.get'), '/llms-full.txt', {headers})
const connect = (file: string, {headers, query}: {headers?: Record<string, string>, query?: Record<string, string>} = {}) =>
    ask(() => import('../server/routes/connect/[file].get'), `/connect/${file}`, {headers, file, query})
const bearer = (key: string) => ({authorization: `Bearer ${key}`})

beforeEach(async () => {
    ({store} = await storeSetup())
    config = {auth: 'on', oidc: {issuer: '', clientId: '', clientSecret: ''}, listenHost: '', public: {environment: 'personal'}}
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('useStorage', () => ({getItem: async () => '# The API reference'}))
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('getCookie', (event: Event, name: string) => new RegExp(`${name}=([^;]+)`).exec(event.headers.cookie ?? '')?.[1])
    vi.stubGlobal('getRequestURL', (event: Event) => new URL(event.path, 'http://orrery.lan:9000'))
    vi.stubGlobal('getQuery', (event: Event) => event.query)
    vi.stubGlobal('param', (event: Event, name: string) => event.params[name])
    vi.stubGlobal('setResponseHeader', () => undefined)
    vi.stubGlobal('createError', (input: {statusCode: number, message: string}) => Object.assign(new Error(input.message), input))
    vi.stubGlobal('notFound', (message: string) => Object.assign(new Error(message), {statusCode: 404}))
    vi.resetModules()
    const guide = await import('../server/utils/guide')
    vi.stubGlobal('overview', guide.overview)
    vi.stubGlobal('apiReference', guide.apiReference)
    vi.stubGlobal('originOf', guide.originOf)
    vi.stubGlobal('mayRead', (await import('../server/utils/auth')).mayRead)
    vi.stubGlobal('authMode', (await import('../server/utils/auth')).authMode)
    await store.nameOwner({name: 'Skoll'})
    agent = (await store.makeKey('skoll', {kind: 'agent', name: 'laptop'})).key
    personal = (await store.makeKey('skoll', {kind: 'person', name: 'claim'})).key
})

afterEach(() => vi.unstubAllGlobals())

describe('with a login on and no credential', () => {
    it('/llms.txt says how to use orrery, with no projects', async () => {
        const text = await llms()
        for (const name of ON_IT) expect(text).not.toContain(name)
        expect(text).toContain('Use it like this')
        expect(text).toContain("its projects aren't listed here")
        expect(text).not.toContain('none yet')
    })

    it('/llms-full.txt keeps the reference, with no projects', async () => {
        const text = await llmsFull()
        for (const name of ON_IT) expect(text).not.toContain(name)
        expect(text).toContain('# The API reference')
    })

    it('/connect says the same of a project that exists and one that does not', async () => {
        await store.createProject({name: 'Second Shelf', id: 'second', key: 'SEC'})
        const there = await connect('second.md')
        const missing = await connect('nothing.md')
        expect(there.replaceAll('second', 'nothing')).toBe(missing)
        for (const text of ['Second Shelf', 'SEC', 'orr_', 'ORRERY_ID']) expect(there).not.toContain(text)
        expect(there).toContain('App settings → You → Your keys')
        expect(there).toContain(`curl -s -H "Authorization: Bearer $ORRERY_KEY" 'http://orrery.lan:9000/connect/second.md'`)
    })

    it("/connect keeps a new project's name and a window's name in the line to ask again, made safe", async () => {
        expect(await connect('shop.md', {query: {name: "Shop'; rm -rf ~ #"}})).toContain("connect/shop-rm-rf.md?name=Shop'")
        expect(await connect('shop.md', {query: {session: 'Front Door'}})).toContain("connect/shop.md?session=front-door'")
    })

    it('/connect gives nothing for a person key, which is no use as a bearer', async () => {
        expect(await connect('greenhouse.md', {headers: bearer(personal)})).not.toContain('issue ids')
        expect(await llms(bearer(personal))).not.toContain('greenhouse')
        expect(await llms(bearer('orrery_agent_made_up'))).not.toContain('greenhouse')
    })
})

describe('with a credential', () => {
    it('/llms.txt lists the projects', async () => {
        expect(await llms(bearer(agent))).toContain('- greenhouse: id `greenhouse`, prefix `GRE`')
        expect(await llmsFull(bearer(agent))).toContain('- greenhouse: id `greenhouse`, prefix `GRE`')
    })

    it('/connect gives the whole brief, for a person logged in on the page too', async () => {
        const {secret} = await store.startLogin('skoll')
        for (const headers of [bearer(agent), {cookie: `orrery_login=${secret}`}]) {
            const brief = await connect('greenhouse.md', {headers})
            expect(brief).toContain('as project `greenhouse` (issue ids `GRE-1`')
            expect(brief).toContain('## Set this repo up')
        }
    })
})

describe("with login off, on one person's machine", () => {
    it('answers as it always has, with no credential', async () => {
        config.auth = 'off'
        expect(await llms()).toContain('- greenhouse: id `greenhouse`, prefix `GRE`')
        expect(await connect('greenhouse.md')).toContain('## Set this repo up')
    })
})

describe('told off on a server others can reach', () => {
    it('shows no projects, even with a key', async () => {
        config.auth = 'off'
        const event = {path: '/llms.txt', method: 'GET', headers: bearer(agent), context: {}, params: {}, query: {},
            node: {req: {headers: {}, socket: {server: {address: () => ({address: '0.0.0.0'})}}}}}
        const {overview} = await import('../server/utils/guide')
        expect(await overview(event as never)).not.toContain('greenhouse')
    })
})
