import {createServer, IncomingMessage, ServerResponse} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {Socket} from 'node:net'
import {createEvent, getHeader} from 'h3'
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {apiStarted, routeToApi, SERVED_BY} from '../server/utils/api-router'

// `/mcp` goes to the Rust API as it came (ORR-1102), and what its tools' routes set off comes back on its reply for this
// server to pass on, as for any route the API answers.

function eventOf(path: string, method: string, headers: Record<string, string>, body?: string) {
    const req = new IncomingMessage(new Socket())
    req.url = path
    req.method = method
    req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    if (body !== undefined) {
        req.headers['content-length'] = String(Buffer.byteLength(body))
        req.push(body)
        req.push(null)
    }
    const res = new ServerResponse(req)
    return {event: createEvent(req, res), res}
}

let api: Server
let asked: {method: string, url: string, headers: Record<string, string | string[] | undefined>, body: string}[] = []
let answer: {status: number, headers: Record<string, string>, body: string}
const handedOn: unknown[] = []
const urgent: unknown[] = []

beforeAll(async () => {
    api = createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            asked.push({method: req.method ?? '', url: req.url ?? '', headers: req.headers, body})
            res.writeHead(answer.status, answer.headers)
            res.end(answer.body)
        })
    })
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
    vi.stubGlobal('useEventLog', () => ({note: () => {}}))
    vi.stubGlobal('actorOf', async () => ({name: 'claude', owner: false, session: 'Kvase'}))
    vi.stubGlobal('databaseSetting', () => 'sqlite:test')
    vi.stubGlobal('getHeader', getHeader)
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    vi.stubGlobal('currentId', (session: string) => session)
    vi.stubGlobal('useScheduler', () => ({changedElsewhere: () => {}}))
    vi.stubGlobal('useStore', () => ({
        relaying: async (run: () => Promise<void>) => run(),
        changed: () => {},
        settingsChanged: async () => {},
        epicsChanged: () => {},
        told: () => {},
        handOn: async (project: string, issue: string, comment: number) => handedOn.push({project, issue, comment}),
        sayUrgent: async (project: string, issue: string) => urgent.push({project, issue}),
    }))
    apiStarted({url: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, token: 't'.repeat(24)})
})

beforeEach(() => {
    asked = []
    handedOn.length = 0
    urgent.length = 0
})

afterAll(async () => {
    apiStarted(null)
    vi.unstubAllGlobals()
    await new Promise<void>(resolve => api.close(() => resolve()))
})

describe('/mcp', () => {
    it('goes to the API with its MCP headers and who is asking, and its session id comes back', async () => {
        answer = {status: 200, headers: {'content-type': 'application/json', 'mcp-session-id': 'abc123'}, body: '{"jsonrpc":"2.0","id":1,"result":{}}'}
        const sent = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
        const {event, res} = eventOf('/mcp', 'POST', {'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'orrery-session': 'Kvase'}, sent)
        const reply = await routeToApi(event, {})
        expect(reply).toBe('{"jsonrpc":"2.0","id":1,"result":{}}')
        expect(res.statusCode).toBe(200)
        expect(res.getHeader('mcp-session-id')).toBe('abc123')
        expect(res.getHeader(SERVED_BY)).toBe('rust')
        const [one] = asked
        expect(one).toMatchObject({method: 'POST', url: '/mcp', body: sent})
        expect(one?.headers).toMatchObject({'orrery-api-token': 't'.repeat(24), 'orrery-actor-name': 'claude', 'orrery-actor-kind': 'session', 'orrery-actor-session': 'Kvase', 'orrery-worked-by': 'Kvase', 'mcp-protocol-version': '2025-06-18', 'accept': 'application/json, text/event-stream'})
    })

    it("passes on what a tool's routes set off: the comment to its session and the urgent push", async () => {
        answer = {status: 200, headers: {'content-type': 'application/json', 'orrery-carry': 'alpha ALP%2D1 3', 'orrery-urgent': 'alpha ALP%2D2'}, body: '{"jsonrpc":"2.0","id":2,"result":{}}'}
        const {event} = eventOf('/mcp', 'POST', {'content-type': 'application/json', 'mcp-session-id': 'abc123'}, '{"jsonrpc":"2.0","id":2,"method":"tools/call"}')
        await routeToApi(event, {})
        expect(asked[0]?.headers['mcp-session-id']).toBe('abc123')
        expect(handedOn).toEqual([{project: 'alpha', issue: 'ALP-1', comment: 3}])
        expect(urgent).toEqual([{project: 'alpha', issue: 'ALP-2'}])
    })

    it("keeps a notification's 202 and a refusal's status, and passes nothing on from a refusal", async () => {
        answer = {status: 202, headers: {}, body: ''}
        const notified = eventOf('/mcp', 'POST', {'content-type': 'application/json'}, '{"jsonrpc":"2.0","method":"notifications/initialized"}')
        expect(await routeToApi(notified.event, {})).toBe('')
        expect(notified.res.statusCode).toBe(202)
        answer = {status: 403, headers: {'content-type': 'application/json', 'orrery-carry': 'alpha ALP%2D1 3'}, body: '{"statusCode":403}'}
        const refused = eventOf('/mcp', 'GET', {})
        await routeToApi(refused.event, {})
        expect(refused.res.statusCode).toBe(403)
        expect(handedOn).toEqual([])
    })
})
