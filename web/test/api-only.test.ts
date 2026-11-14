import {createServer, IncomingMessage, ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'
import {Socket} from 'node:net'
import {createEvent, getHeader} from 'h3'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {apiStarted, askerHeaders, routeToApi, SERVED_BY} from '../server/utils/api-router'

// The routes the Rust API serves are its alone (ORR-1091, once the swap's flag, ORR-1034): an API that can't answer
// fails the request instead of leaving it to Nuxt's routes and store.

function eventOf(path: string, method = 'GET') {
    const req = new IncomingMessage(new Socket())
    req.url = path
    req.method = method
    return createEvent(req, new ServerResponse(req))
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    await new Promise<void>(resolve => server.close(() => resolve()))
    return port
}

const noted: {level: string, kind: string, message: string}[] = []
let errors: ReturnType<typeof vi.spyOn>
let warnings: ReturnType<typeof vi.spyOn>
let infos: ReturnType<typeof vi.spyOn>

beforeAll(() => {
    vi.stubGlobal('useEventLog', () => ({note: (entry: {level: string, kind: string, message: string}) => noted.push(entry)}))
    vi.stubGlobal('actorOf', async () => ({name: 'steffen', owner: true}))
    vi.stubGlobal('databaseSetting', () => 'sqlite:test')
    vi.stubGlobal('getHeader', getHeader)
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    infos = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
    apiStarted(null)
    noted.length = 0
    errors.mockClear()
    warnings.mockClear()
    infos.mockClear()
})

afterAll(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('the routes the API serves', () => {
    it('fail with the API down instead of falling through, and say so once in the log', async () => {
        apiStarted({url: `http://127.0.0.1:${await closedPort()}`, token: 't'.repeat(24)})
        for (let i = 0; i < 2; i++) {
            const failed = await routeToApi(eventOf('/api/statuses'), {}).then(() => undefined, (error: unknown) => error)
            expect(failed).toMatchObject({statusCode: 503, statusMessage: 'The Rust API can\'t be reached'})
            expect((failed as Error).message).toMatch(/can't be reached .*GET \/api\/statuses.*the API's alone/)
        }
        expect(noted).toEqual([expect.objectContaining({level: 'error', kind: 'api.unreachable'})])
        expect(errors).toHaveBeenCalledTimes(1)
    })

    it('fail with no API running, those that keep a route here for some requests too (ORR-1091)', async () => {
        await expect(routeToApi(eventOf('/api/projects/p/docs'), {})).rejects.toMatchObject({statusCode: 503})
        await expect(routeToApi(eventOf('/api/projects/p/issues', 'POST'), {})).rejects.toMatchObject({statusCode: 503})
        await expect(routeToApi(eventOf('/api/projects/p/issues/P-1', 'PATCH'), {})).rejects.toMatchObject({statusCode: 503})
    })

    it('fail when the API is on another database', async () => {
        const api = createServer((_req, res) => {
            res.statusCode = 421
            res.end()
        })
        await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
        try {
            apiStarted({url: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, token: 't'.repeat(24)})
            await expect(routeToApi(eventOf('/api/statuses'), {})).rejects.toThrow(/on another database/)
        } finally {
            await new Promise<void>(resolve => api.close(() => resolve()))
        }
    })

    it('leave what the API doesn\'t serve to the routes here', async () => {
        expect(await routeToApi(eventOf('/api/sessions'), {})).toBeUndefined()
        expect(await routeToApi(eventOf('/api/projects/p/issues/P-1/start', 'POST'), {})).toBeUndefined()
    })
})

// Which server answered (ORR-1085): a header on every `/api/` reply, and a line a request for the exceptions.
describe('which server answered', () => {
    const servedBy = (event: ReturnType<typeof eventOf>) => event.node.res.getHeader(SERVED_BY)
    const lines = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[orrery api-route]'))

    /** A stand-in API answering every request with `status` and `type`. */
    async function apiAnswering(status: number, type: string, body: string) {
        const api = createServer((_req, res) => {
            res.statusCode = status
            res.setHeader('Content-Type', type)
            res.end(body)
        })
        await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
        apiStarted({url: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, token: 't'.repeat(24)})
        return () => new Promise<void>(resolve => api.close(() => resolve()))
    }

    it('says nuxt for a path the API doesn\'t serve, and logs nothing', async () => {
        const event = eventOf('/api/sessions')
        expect(await routeToApi(event, {})).toBeUndefined()
        expect(servedBy(event)).toBe('nuxt')
        expect([...lines(infos), ...lines(warnings)]).toEqual([])
    })

    it('says rust for a routed path the API answered, its refusals too', async () => {
        const close = await apiAnswering(200, 'image/png', 'png')
        try {
            const event = eventOf('/api/uploads/a.png')
            expect(String(await routeToApi(event, {}))).toBe('png')
            expect(servedBy(event)).toBe('rust')
        } finally {
            await close()
        }
        const closeRefusing = await apiAnswering(404, 'application/json', JSON.stringify({statusMessage: 'Not found'}))
        try {
            const event = eventOf('/api/statuses/nope')
            await expect(routeToApi(event, {})).rejects.toMatchObject({statusCode: 404})
            expect(servedBy(event)).toBe('rust')
        } finally {
            await closeRefusing()
        }
    })

    it('logs served=none a request with its reason when no API is running', async () => {
        for (let i = 0; i < 2; i++) await expect(routeToApi(eventOf('/api/projects/P/issues', 'POST'), {})).rejects.toMatchObject({statusCode: 503})
        expect(lines(warnings)).toEqual(Array(2).fill('[orrery api-route] served=none reason=not-running domain="an issue, made" method=POST path=/api/projects/P/issues'))
    })

    it('logs served=none with its reason when the request fails instead', async () => {
        const close = await apiAnswering(421, 'application/json', '')
        try {
            await expect(routeToApi(eventOf('/api/statuses'), {})).rejects.toMatchObject({statusCode: 503})
        } finally {
            await close()
        }
        expect(lines(warnings)).toEqual(['[orrery api-route] served=none reason=other-database domain="statuses" method=GET path=/api/statuses'])
    })
})

describe('what the API is told of the asker (ORR-1059)', () => {
    const asking = (headers: Record<string, string>) => {
        const event = eventOf('/api/projects/orrery/issues', 'POST')
        Object.assign(event.node.req.headers, headers)
        return event
    }

    it('tells the chat\'s status and which chat it is, and no session to note, as what the chat makes is for others to work', () => {
        vi.stubGlobal('chatIssuesFor', (chat?: string) => chat === 'c-1' ? 'backlog' : 'todo')
        vi.stubGlobal('currentId', (id: string) => id)
        const event = asking({'orrery-launch': 'c-1', 'orrery-session': 's-1'})
        expect(askerHeaders(event, {name: 'claude', owner: false, chat: true})).toEqual({'Orrery-Chat-Issues': 'backlog', 'Orrery-Launch': 'c-1'})
    })

    it('tells a session\'s id as it is after a /clear, an untrusted one\'s too, and nothing with no session', () => {
        vi.stubGlobal('currentId', (id: string) => id === 'old id' ? 'new id' : id)
        const event = asking({'orrery-session': 'old id'})
        expect(askerHeaders(event, {name: 'claude', owner: false})).toEqual({'Orrery-Worked-By': 'new%20id'})
        expect(askerHeaders(event, {name: 'outsider', owner: false, untrusted: true, chat: true})).toEqual({'Orrery-Worked-By': 'new%20id'})
        expect(askerHeaders(asking({}), {name: 'steffen', owner: true})).toEqual({})
    })
})
