import {createServer, IncomingMessage, ServerResponse} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {Socket} from 'node:net'
import {createEvent, getHeader} from 'h3'
import type {H3Event} from 'h3'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {apiForgotten, apiStarted, routeToApi, SERVED_BY, writeToApi} from '../server/utils/api-router'

// What the router does around a request the Rust API answers, which only its own unit tests reach (ORR-1123): the parity
// tests send their requests to the API itself, so its JSON replies, the checks a line keeps here first, and the relay of
// what a write set off while this server isn't following the outbox would read as covered by nothing.

const outbox = vi.hoisted(() => ({following: false, caughtUp: 0}))
vi.mock('../server/utils/outbox-follower', async original => ({
    ...await original<typeof import('../server/utils/outbox-follower')>(),
    followingOutbox: () => outbox.following,
    caughtUp: async () => void outbox.caughtUp++,
}))
const usage = vi.hoisted(() => ({flushed: 0, dropped: 0, counted: [] as string[]}))
vi.mock('../server/utils/usage', async original => ({
    ...await original<typeof import('../server/utils/usage')>(),
    flushUse: async () => void usage.flushed++,
    dropGathered: () => void usage.dropped++,
    countOwnUse: (_event: unknown, feature: string) => void usage.counted.push(feature),
    usageAllowed: () => true,
}))

function eventOf(path: string, method = 'GET', body?: string, headers: Record<string, string> = {}) {
    const req = new IncomingMessage(new Socket())
    req.url = path
    req.method = method
    req.headers = {...headers}
    if (body !== undefined) {
        req.headers['content-length'] = String(Buffer.byteLength(body))
        req.push(body)
        req.push(null)
    }
    const res = new ServerResponse(req)
    return {event: createEvent(req, res), res}
}

type Asked = {method: string, url: string, body: string}
let api: Server
let url = ''
let asked: Asked[] = []
let answer: {status: number, headers?: Record<string, string>, body?: string} = {status: 200, body: '{}'}
let actor: {name: string, owner: boolean, session?: string} = {name: 'steffen', owner: true}
let chat = false
let untrusted = false
let session: string | undefined
const calls: string[] = []
const noted: {kind: string, message: string, project?: string, details?: unknown}[] = []

beforeAll(async () => {
    api = createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            asked.push({method: req.method ?? '', url: req.url ?? '', body})
            res.writeHead(answer.status, {'Content-Type': 'application/json', ...answer.headers})
            res.end(answer.body ?? '')
        })
    })
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    vi.stubGlobal('getHeader', getHeader)
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    vi.stubGlobal('databaseSetting', () => 'sqlite:test')
    vi.stubGlobal('actorOf', async () => actor)
    vi.stubGlobal('chatWrite', () => chat)
    vi.stubGlobal('untrustedWrite', () => untrusted)
    vi.stubGlobal('sessionHeader', () => session)
    vi.stubGlobal('asChatEdit', (body: object) => void calls.push(`asChatEdit ${Object.keys(body).join(',')}`))
    vi.stubGlobal('claimFor', async (_event: H3Event, project: string, issue: string) => void calls.push(`claimFor ${project} ${issue}`))
    vi.stubGlobal('needsBoard', async (_event: H3Event, project: string) => void calls.push(`needsBoard ${project}`))
    vi.stubGlobal('useEventLog', () => ({note: (entry: typeof noted[number]) => noted.push(entry)}))
    vi.stubGlobal('useScheduler', () => ({changedElsewhere: (project: string) => calls.push(`schedules ${project}`)}))
    vi.stubGlobal('useStore', () => ({
        relaying: async (run: () => Promise<void>) => await run(),
        changed: (project: string) => calls.push(`changed ${project}`),
        settingsChanged: async () => void calls.push('settings'),
        epicsChanged: () => void calls.push('epics'),
        told: () => {},
        handOn: async () => {},
        sayUrgent: async () => {},
    }))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

beforeEach(() => {
    apiStarted({url, token: 't'.repeat(24)})
    asked = []
    answer = {status: 200, body: '{}'}
    actor = {name: 'steffen', owner: true}
    chat = false
    untrusted = false
    session = undefined
    calls.length = 0
    noted.length = 0
    outbox.following = false
    outbox.caughtUp = 0
    usage.flushed = 0
    usage.dropped = 0
    usage.counted.length = 0
})

afterEach(() => {
    apiStarted(null)
    apiForgotten()
})

afterAll(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await new Promise<void>(resolve => api.close(() => resolve()))
})

const enc = encodeURIComponent

describe('a write the API answers, while this server follows no outbox', () => {
    it('tells what it set off: the settings, the epics, the schedules, and the event log\'s lines', async () => {
        answer = {status: 200, body: '{"model":"x"}', headers: {
            'Orrery-Settings': '1',
            'Orrery-Epics': '1',
            'Orrery-Schedules': 'p,q%20r',
            'Orrery-Settings-Keys': 'model,theme',
            'Orrery-Asked': `p P-1 3 column,when ${enc('move it to done')}`,
            'Orrery-Answered': `p P-2 - ${enc('')} denied ${enc('wake it at 9')}`,
        }}
        const {event, res} = eventOf('/api/settings', 'PATCH', '{"model":"x"}', {'content-type': 'application/json'})
        expect(await routeToApi(event, {})).toEqual({model: 'x'})
        expect(res.getHeader(SERVED_BY)).toBe('rust')
        expect(res.getHeader('content-type')).toBe('application/json')
        expect(asked).toEqual([{method: 'PATCH', url: '/api/settings', body: '{"model":"x"}'}])
        expect(calls).toEqual(['settings', 'epics', 'schedules p', 'schedules q r'])
        expect(noted).toEqual([
            {level: 'info', kind: 'settings.changed', message: 'steffen changed the settings: model, theme', details: {by: 'steffen', keys: ['model', 'theme']}},
            {level: 'info', kind: 'schedule.asked', project: 'p', message: 'steffen asked on P-1 to move it to done', details: {issue: 'P-1', schedule: 3, fields: ['column', 'when']}},
            {level: 'info', kind: 'schedule.answered', project: 'p', message: 'steffen denied the request on P-2 to wake it at 9', details: {issue: 'P-2', schedule: null, fields: [], allowed: false}},
        ])
        expect(outbox.caughtUp).toBe(0)
    })

    it('notes no ask or answer whose header doesn\'t parse', async () => {
        answer = {status: 200, body: '{}', headers: {'Orrery-Asked': 'p P-1', 'Orrery-Answered': 'p P-1 - x maybe line'}}
        await routeToApi(eventOf('/api/settings', 'PATCH', '{}').event, {})
        expect(noted).toEqual([])
    })
})

describe('a write the API answers, while this server follows the outbox', () => {
    it('leaves what it set off to the outbox, and waits until it has caught up before replying', async () => {
        outbox.following = true
        answer = {status: 200, body: '{}', headers: {'Orrery-Settings': '1', 'Orrery-Epics': '1', 'Orrery-Schedules': 'p', 'Orrery-Changed': 'p'}}
        await routeToApi(eventOf('/api/settings', 'PATCH', '{}').event, {})
        expect(calls).toEqual([])
        expect(outbox.caughtUp).toBe(1)
    })

    it('doesn\'t wait for a read', async () => {
        outbox.following = true
        await routeToApi(eventOf('/api/settings').event, {})
        expect(outbox.caughtUp).toBe(0)
    })
})

describe('the API\'s reply', () => {
    it('with no content is null, with its status', async () => {
        answer = {status: 204}
        const {event, res} = eventOf('/api/statuses/s1', 'DELETE')
        expect(await routeToApi(event, {})).toBeNull()
        expect(res.statusCode).toBe(204)
    })

    it('that refuses fails as the route here would, its data and all', async () => {
        answer = {status: 422, body: JSON.stringify({statusMessage: 'Unprocessable', message: 'No such status', data: {field: 'name'}})}
        await expect(routeToApi(eventOf('/api/statuses', 'POST', '{}').event, {})).rejects.toMatchObject({statusCode: 422, message: 'No such status', data: {field: 'name'}})
    })

    it('keeps the name a file is saved as, once the board check here has let it through', async () => {
        answer = {status: 200, body: '{"issues":[]}', headers: {'Content-Disposition': 'attachment; filename="p.json"'}}
        const {event, res} = eventOf('/api/projects/p/export')
        expect(await routeToApi(event, {})).toEqual({issues: []})
        expect(res.getHeader('content-disposition')).toBe('attachment; filename="p.json"')
        expect(calls).toEqual(['needsBoard p'])
    })

    it('counts toward the owner\'s use of a feature once the API has said yes', async () => {
        await routeToApi(eventOf('/api/presets', 'POST', '{}').event, {})
        expect(usage.counted).toEqual(['presets'])
        answer = {status: 400, body: '{}'}
        await expect(routeToApi(eventOf('/api/presets', 'POST', '{}').event, {})).rejects.toMatchObject({statusCode: 400})
        expect(usage.counted).toEqual(['presets'])
    })
})

describe('usage', () => {
    it('gathers what\'s counted here before the read, and puts in this server\'s own `allowed`', async () => {
        answer = {status: 200, body: '{"on":true,"features":[{"name":"presets"}],"extra":1}'}
        expect(await routeToApi(eventOf('/api/usage').event, {})).toEqual({on: true, allowed: true, features: [{name: 'presets'}]})
        expect(usage.flushed).toBe(1)
    })

    it('drops what\'s gathered here when the owner forgets the counts, and keeps it for anyone else', async () => {
        answer = {status: 204}
        await routeToApi(eventOf('/api/usage', 'DELETE').event, {})
        expect(usage.dropped).toBe(1)
        actor = {name: 'ana', owner: false}
        await routeToApi(eventOf('/api/usage', 'DELETE').event, {})
        expect(usage.dropped).toBe(1)
        expect(asked).toHaveLength(2)
    })
})

describe('an issue\'s edit', () => {
    const edit = (body: string) => routeToApi(eventOf('/api/projects/p/issues/P-1', 'PATCH', body).event, {})

    it('stays here when its body isn\'t JSON, or names more than its words', async () => {
        expect(await edit('{not json')).toBeUndefined()
        expect(await edit('{"title":"x","session":"y"}')).toBeUndefined()
        expect(await edit('{}')).toBeUndefined()
        expect(asked).toEqual([])
        expect(vi.mocked(console.info)).toHaveBeenLastCalledWith(expect.stringContaining('served=nuxt reason=kept-here check=wordsOnly'))
    })

    it('goes on with the owner\'s words, once the session\'s claim on the issue is checked', async () => {
        answer = {status: 200, body: '{"id":"P-1"}'}
        expect(await edit('{"title":"x","status":"done"}')).toEqual({id: 'P-1'})
        expect(calls).toEqual(['claimFor p P-1'])
        expect(asked.map(a => a.body)).toEqual(['{"title":"x","status":"done"}'])
    })

    it('goes on with the chat\'s, kept to what it may change', async () => {
        chat = true
        await edit('{"title":"x"}')
        expect(calls).toEqual(['asChatEdit title'])
        expect(asked).toHaveLength(1)
    })

    it('stays here when a session moves its status, as the lock on it is this server\'s', async () => {
        actor = {name: 'claude', owner: false, session: 'Kvase'}
        session = 'Kvase'
        expect(await edit('{"status":"in-progress"}')).toBeUndefined()
        expect(await edit('{"plan":"in-progress"}')).toBeUndefined()
        expect(asked).toEqual([])
        await edit('{"title":"x"}')
        expect(calls).toEqual(['claimFor p P-1'])
    })
})

describe('a new issue', () => {
    const made = (body: string) => routeToApi(eventOf('/api/projects/p/issues', 'POST', body).event, {})

    it('goes on with only its words, and stays here otherwise', async () => {
        expect(await made('{"title":"x"}')).toEqual({})
        expect(await made('{"title":"x","session":"y"}')).toBeUndefined()
        expect(await made('{nope')).toBeUndefined()
        expect(asked).toHaveLength(1)
    })

    it('from an untrusted session always goes on, as the API keeps only its words', async () => {
        untrusted = true
        await made('{"title":"x","session":"y"}')
        expect(asked).toHaveLength(1)
    })
})

describe('an API on another database', () => {
    let other: Server
    let otherUrl = ''

    beforeAll(async () => {
        other = createServer((_req, res) => {
            res.statusCode = 421
            res.end()
        })
        await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
        otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        await new Promise<void>(resolve => other.close(() => resolve()))
    })

    it('fails `/mcp`, and this server\'s own writes', async () => {
        apiStarted({url: otherUrl, token: 't'.repeat(24)})
        await expect(routeToApi(eventOf('/mcp', 'POST', '{}').event, {})).rejects.toThrow(/on another database/)
        await expect(writeToApi('PATCH', '/api/settings', {model: 'x'}, actor, {config: {}})).rejects.toThrow(/on another database/)
    })

    it('and one that can\'t be reached fails `/mcp` too', async () => {
        apiStarted({url: 'http://127.0.0.1:1', token: 't'.repeat(24)})
        await expect(routeToApi(eventOf('/mcp', 'POST', '{}').event, {})).rejects.toMatchObject({statusCode: 503})
    })
})
