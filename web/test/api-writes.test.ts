import {createServer} from 'node:http'
import type {Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {apiStarted, writeToApi} from '../server/utils/api-router'

// The local app's own board writes, such as the chat's Allow (ORR-1044): with the Rust API in front they go to it as the
// page's request would, so it stays the one writer of its tables; without it, they're left to the store here.

type Heard = {method: string, url: string, headers: Record<string, string | string[] | undefined>, body: string}

let server: Server
let url = ''
const heard: Heard[] = []
/** What the fake API answers next: status, JSON body and headers. */
let answer: {status: number, body?: unknown, headers?: Record<string, string>} = {status: 200, body: {}}
const changed: string[] = []

beforeAll(async () => {
    vi.stubGlobal('useEventLog', () => ({note: () => {}}))
    vi.stubGlobal('databaseSetting', () => 'sqlite:test')
    vi.stubGlobal('useStore', () => ({
        relaying: async (run: () => Promise<void>) => await run(),
        changed: (project: string) => changed.push(project),
        settingsChanged: async () => {},
        epicsChanged: () => {},
        told: () => {},
        handOn: async () => {},
        sayUrgent: async () => {},
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server = createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            heard.push({method: req.method ?? '', url: req.url ?? '', headers: req.headers, body})
            res.writeHead(answer.status, {'Content-Type': 'application/json', ...answer.headers})
            res.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => {
    heard.length = 0
    changed.length = 0
    answer = {status: 200, body: {}}
})

afterEach(() => apiStarted(null))

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const owner = {name: 'steffen', owner: true, via: 'chat'}

describe('a write of the local app\'s own', () => {
    it('with no API, is left to the store here', async () => {
        expect(await writeToApi('PATCH', '/api/projects/p/issues/P-1', {status: 'done'}, owner, {config: {}})).toBeUndefined()
        expect(heard).toEqual([])
    })

    it('goes to the API as the page\'s request would, as who it\'s for, and tells what it changed', async () => {
        apiStarted({url, token: 't'.repeat(24)})
        answer = {status: 200, body: {id: 'P-1', status: 'done'}, headers: {'Orrery-Changed': 'p'}}
        const sent = await writeToApi('PATCH', '/api/projects/p/issues/P-1', {status: 'done'}, owner, {config: {}})
        expect(sent).toEqual({reply: {id: 'P-1', status: 'done'}})
        expect(heard).toHaveLength(1)
        expect(heard[0]).toMatchObject({method: 'PATCH', url: '/api/projects/p/issues/P-1', body: '{"status":"done"}'})
        expect(heard[0]!.headers).toMatchObject({'orrery-api-token': 't'.repeat(24), 'orrery-actor-name': 'steffen', 'orrery-actor-owner': '1', 'orrery-actor-kind': 'owner'})
        expect(changed).toEqual(['p'])
    })

    it('stays here for a route the API doesn\'t serve, unless it\'s one only this server calls (`always`)', async () => {
        apiStarted({url, token: 't'.repeat(24)})
        expect(await writeToApi('PUT', '/api/chats/c1', {id: 'c1'}, owner, {config: {}})).toBeUndefined()
        expect(heard).toEqual([])
        answer = {status: 204}
        expect(await writeToApi('PUT', '/api/chats/c1', {id: 'c1'}, owner, {always: true, config: {}})).toEqual({reply: null})
        expect(heard.map(h => `${h.method} ${h.url}`)).toEqual(['PUT /api/chats/c1'])
    })

    it('fails as the route here would when the API refuses it', async () => {
        apiStarted({url, token: 't'.repeat(24)})
        answer = {status: 409, body: {statusMessage: 'Conflict', message: 'Doc "d" has changed since then'}}
        await expect(writeToApi('PATCH', '/api/projects/p/docs/d', {body: 'x'}, owner, {config: {}})).rejects.toMatchObject({statusCode: 409, message: 'Doc "d" has changed since then'})
    })

    it('with the swap on and no API running, fails rather than writing here', async () => {
        await expect(writeToApi('PATCH', '/api/settings', {model: 'x'}, owner, {config: {apiOnly: '1'}})).rejects.toMatchObject({statusCode: 503})
    })
})
