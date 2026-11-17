import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Moving an orrery from App settings (ORR-1249): who may, what address it takes, the two sides it builds, and a run as
// the page follows it. The route's h3 helpers are Nitro auto-imports, stood in for here; the import itself is
// shared/import-orrery.mjs, tested in import-orrery.test.ts.
type Moves = typeof import('../server/utils/orrery-moves')
let moves: Moves
type Event = {headers: Record<string, string>, context: {who?: {via: string, owner: boolean}}, actor: Record<string, unknown>, node: {req: {socket: {localAddress?: string, localPort?: number}}}}

const event = (actor: Record<string, unknown>, who?: {via: string, owner: boolean}, headers: Record<string, string> = {}, socket: {localAddress?: string, localPort?: number} = {}): Event =>
    ({headers: {host: 'localhost:9010', ...headers}, context: who ? {who} : {}, actor, node: {req: {socket}}})
const KEY = 'orrery_person_SECRETSECRETSECRET'

beforeEach(async () => {
    vi.stubGlobal('createError', (e: {statusCode: number, message: string}) => Object.assign(new Error(e.message), e))
    vi.stubGlobal('actorOf', async (e: Event) => e.actor)
    vi.stubGlobal('sessionHeader', (e: Event) => e.headers['orrery-session'])
    vi.stubGlobal('getRequestURL', (e: Event) => new URL(`http://${e.headers.host}/api/orrery-moves`))
    vi.stubGlobal('getRequestHeaders', (e: Event) => e.headers)
    vi.resetModules()
    moves = await import('../server/utils/orrery-moves')
    moves.forgetMoves()
})

afterEach(() => vi.unstubAllGlobals())

describe("the other orrery's address", () => {
    it('is https, or plain http to this machine alone', () => {
        expect(moves.moveRemoteOrigin('https://orrery.example.com/')).toBe('https://orrery.example.com')
        expect(moves.moveRemoteOrigin(' http://localhost:9010 ')).toBe('http://localhost:9010')
        expect(moves.moveRemoteOrigin('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000')
        expect(() => moves.moveRemoteOrigin('http://orrery.example.com')).toThrow(/https/)
        expect(() => moves.moveRemoteOrigin('ftp://localhost')).toThrow(/https/)
        expect(() => moves.moveRemoteOrigin('https://me:pw@orrery.example.com')).toThrow(/alone/)
        expect(() => moves.moveRemoteOrigin('not a url')).toThrow(/address/)
    })
})

describe('what a move asks', () => {
    it('takes the fields the import does, checked', () => {
        expect(moves.moveAskOf({direction: 'send', url: 'https://o.example.com', key: ` ${KEY} `, name: ' Personal ', color: 'teal', add: true, dryRun: 'yes'}))
            .toEqual({direction: 'send', url: 'https://o.example.com', key: KEY, name: 'Personal', from: 'default', color: 'teal', add: true, dryRun: false, enableSchedules: false})
        // Its flags in snake_case, as the API's bodies are, or camelCase, as the page sent them (ORR-1287).
        for (const flags of [{dry_run: true, enable_schedules: true}, {dryRun: true, enableSchedules: true}])
            expect(moves.moveAskOf({direction: 'send', url: 'https://o.example.com', name: 'x', ...flags})).toMatchObject({dryRun: true, enableSchedules: true})
        expect(moves.moveAskOf({direction: 'bring', url: 'https://o.example.com', name: 'x', from: 'work'}).from).toBe('work')
        expect(moves.moveAskOf({direction: 'bring', url: 'https://o.example.com', name: 'x', from: '../etc'}).from).toBe('default')
        expect(() => moves.moveAskOf({direction: 'up', url: 'https://o.example.com', name: 'x'})).toThrow(/direction/)
        expect(() => moves.moveAskOf({direction: 'send', url: 'https://o.example.com', name: ''})).toThrow(/Name/)
        expect(() => moves.moveAskOf({direction: 'send', url: 'https://o.example.com', name: 'x', color: 'plaid'})).toThrow(/color/)
    })
})

describe('who may move one', () => {
    const refused = /Only the owner/
    it("the owner, from their own page", async () => {
        await expect(moves.moveByOwnersPage(event({owner: true}, {via: 'browser', owner: true}) as never)).resolves.toBeUndefined()
        // With login off, the request that names the owner and isn't a session's.
        await expect(moves.moveByOwnersPage(event({owner: true}) as never)).resolves.toBeUndefined()
    })
    it('not a key, a session, a chat, an untrusted one or another person', async () => {
        await expect(moves.moveByOwnersPage(event({owner: false}, {via: 'key', owner: true}) as never)).rejects.toThrow(refused)
        await expect(moves.moveByOwnersPage(event({owner: false}, {via: 'browser', owner: false}) as never)).rejects.toThrow(refused)
        await expect(moves.moveByOwnersPage(event({owner: true}, undefined, {'orrery-session': 'window-a'}) as never)).rejects.toThrow(refused)
        await expect(moves.moveByOwnersPage(event({owner: true, session: 'a'}) as never)).rejects.toThrow(refused)
        await expect(moves.moveByOwnersPage(event({owner: true, chat: true}) as never)).rejects.toThrow(refused)
        await expect(moves.moveByOwnersPage(event({owner: true, untrusted: true}) as never)).rejects.toThrow(refused)
    })
})

describe('the two sides', () => {
    const ask = (more: Record<string, unknown> = {}) => moves.moveAskOf({direction: 'send', url: 'https://o.example.com', key: KEY, name: 'Personal', ...more})
    it('sends with the key to the other orrery, and refuses one that is this one', async () => {
        const sent: {url: string, auth?: string}[] = []
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            sent.push({url, auth: (init.headers as Record<string, string>).Authorization})
            return new Response(JSON.stringify([{id: 'default', name: 'Default'}]))
        })
        const {source, target, workspaces} = await moves.moveSides(event({owner: true}) as never, ask())
        expect(source.url).toBe('http://localhost:9010')
        expect(target.url).toBe('https://o.example.com')
        expect(workspaces).toEqual([{id: 'default', name: 'Default'}])
        expect(sent).toEqual([{url: 'https://o.example.com/api/workspaces', auth: `Bearer ${KEY}`}])
        const bring = await moves.moveSides(event({owner: true}) as never, ask({direction: 'bring'}))
        expect(bring.source.url).toBe('https://o.example.com')
        await expect(moves.moveSides(event({owner: true}) as never, ask({url: 'http://localhost:9010'}))).rejects.toThrow(/this orrery/)
    })
    it("says so when the key isn't taken, or there are no workspaces", async () => {
        vi.stubGlobal('fetch', async () => new Response('{"message":"no"}', {status: 401}))
        await expect(moves.moveSides(event({owner: true}) as never, ask())).rejects.toThrow(/didn't take that key/)
        vi.stubGlobal('fetch', async () => new Response('{"projects":[]}'))
        await expect(moves.moveSides(event({owner: true}) as never, ask())).rejects.toThrow(/rc\.19/)
    })
    it("asks this orrery again as the page that asked, over the address it came in on", async () => {
        // This orrery, as a server that says what each request it's asked brings.
        const heard: {method?: string, url?: string, headers: Record<string, unknown>, body: string}[] = []
        const here = createServer((req, res) => {
            let body = ''
            req.on('data', chunk => { body += chunk })
            req.on('end', () => {
                heard.push({method: req.method, url: req.url, headers: req.headers, body})
                res.setHeader('content-type', 'application/json')
                res.end('[]')
            })
        })
        await new Promise<void>(resolve => here.listen(0, '127.0.0.1', resolve))
        try {
            vi.stubGlobal('fetch', async () => new Response('[]'))
            const socket = {localAddress: '127.0.0.1', localPort: (here.address() as AddressInfo).port}
            const page = event({owner: true}, {via: 'browser', owner: true}, {'cookie': 'orrery_login=abc', 'origin': 'http://localhost:9010', 'orrery-workspace': 'work', 'content-length': '99'}, socket)
            const {source} = await moves.moveSides(page as never, ask())
            await source.get('/projects', {workspace: 'default'})
            await (source as unknown as {post: (path: string, body: unknown) => Promise<unknown>}).post('/settings', {tint: 'teal'})
            expect(heard.map(h => [h.method, h.url, h.body])).toEqual([['GET', '/api/projects', ''], ['POST', '/api/settings', '{"tint":"teal"}']])
            // Its own Host, Origin and login, so it passes the checks the browser did; the workspace the import's, not the page's.
            expect(heard[0]!.headers).toMatchObject({'host': 'localhost:9010', 'cookie': 'orrery_login=abc', 'origin': 'http://localhost:9010', 'orrery-workspace': 'default'})
            expect(heard[1]!.headers).toMatchObject({'content-type': 'application/json', 'content-length': '15'})
        } finally {
            here.close()
        }
    })
})

describe('a run', () => {
    it('is followed to its end, and never holds the key', async () => {
        let finish!: (report: unknown) => void
        const run = moves.startMove({direction: 'send', remote: 'https://o.example.com', workspace: 'Personal'}, async ({log, progress}) => {
            log('Made workspace "Personal" (personal)')
            progress({step: 'uploading', project: 'home', done: 0, total: 2})
            return new Promise(resolve => { finish = resolve })
        })
        expect(moves.moveRun(run.id)).toMatchObject({state: 'running', progress: {step: 'uploading', done: 0, total: 2}, lines: ['Made workspace "Personal" (personal)']})
        finish({from: 'http://localhost:9010', to: 'https://o.example.com', dryRun: false, workspace: {id: 'personal', name: 'Personal'}, projects: [], notes: []})
        await vi.waitFor(() => expect(moves.moveRun(run.id)?.state).toBe('done'))
        const done = moves.moveRun(run.id)!
        expect(done.summary).toMatch(/as workspace "Personal"/)
        expect(JSON.stringify(done)).not.toContain(KEY)
        expect(moves.moveRun('nope')).toBeUndefined()
    })
    it('says why it stopped', async () => {
        const run = moves.startMove({direction: 'bring', remote: 'https://o.example.com', workspace: 'Work'}, async () => {
            throw new Error('GET /projects: 500 boom')
        })
        await vi.waitFor(() => expect(moves.moveRun(run.id)?.state).toBe('failed'))
        expect(moves.moveRun(run.id)?.error).toBe('GET /projects: 500 boom')
    })
})
