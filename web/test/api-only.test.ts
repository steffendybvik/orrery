import {createServer, IncomingMessage, ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'
import {Socket} from 'node:net'
import {createEvent, getHeader} from 'h3'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {apiOnly, apiStarted, routeToApi} from '../server/utils/api-router'

// The swap's flag (ORR-1034): on, the routes the Rust API serves are its alone, so an API that can't answer fails the
// request instead of leaving it to Nuxt's routes and store. Most of those routes are gone from Nuxt (ORR-1041), so for
// them it fails either way; the flag still matters for the few lines that keep a route here (`here`).

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

beforeAll(() => {
    vi.stubGlobal('useEventLog', () => ({note: (entry: {level: string, kind: string, message: string}) => noted.push(entry)}))
    vi.stubGlobal('actorOf', async () => ({name: 'steffen', owner: true}))
    vi.stubGlobal('databaseSetting', () => 'sqlite:test')
    vi.stubGlobal('getHeader', getHeader)
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    apiStarted(null)
    noted.length = 0
    errors.mockClear()
    warnings.mockClear()
})

afterAll(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('the swap flag', () => {
    it('is off unless it says so', () => {
        for (const value of [undefined, '', false, 'false', '0', 'off']) expect(apiOnly({apiOnly: value}), String(value)).toBe(false)
        for (const value of [true, 1, '1', 'true', 'on', 'TRUE']) expect(apiOnly({apiOnly: value}), String(value)).toBe(true)
    })

    it('on, fails a routed request with the API down instead of falling through, and says so once in the log', async () => {
        apiStarted({url: `http://127.0.0.1:${await closedPort()}`, token: 't'.repeat(24)})
        for (let i = 0; i < 2; i++) {
            const failed = await routeToApi(eventOf('/api/statuses'), {apiOnly: '1'}).then(() => undefined, (error: unknown) => error)
            expect(failed).toMatchObject({statusCode: 503, statusMessage: 'The Rust API can\'t be reached'})
            expect((failed as Error).message).toMatch(/can't be reached .*NUXT_API_ONLY.*GET \/api\/statuses/)
        }
        expect(noted).toEqual([expect.objectContaining({level: 'error', kind: 'api.unreachable'})])
        expect(errors).toHaveBeenCalledTimes(1)
    })

    it('off, still fails a request for a domain with no route here left, with the API down (ORR-1041)', async () => {
        apiStarted({url: `http://127.0.0.1:${await closedPort()}`, token: 't'.repeat(24)})
        await expect(routeToApi(eventOf('/api/statuses'), {})).rejects.toMatchObject({statusCode: 503})
    })

    it('on or off, fails a request for a domain with no route here when no API is running, and off leaves one with a route here to it', async () => {
        await expect(routeToApi(eventOf('/api/projects/p/docs'), {apiOnly: true})).rejects.toMatchObject({statusCode: 503})
        await expect(routeToApi(eventOf('/api/projects/p/docs'), {})).rejects.toMatchObject({statusCode: 503})
        await expect(routeToApi(eventOf('/api/projects/p/issues', 'POST'), {apiOnly: true})).rejects.toMatchObject({statusCode: 503})
        expect(await routeToApi(eventOf('/api/projects/p/issues', 'POST'), {})).toBeUndefined()
    })

    it('on or off, fails a request for a domain with no route here when the API is on another database', async () => {
        const api = createServer((_req, res) => {
            res.statusCode = 421
            res.end()
        })
        await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
        try {
            apiStarted({url: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, token: 't'.repeat(24)})
            await expect(routeToApi(eventOf('/api/statuses'), {apiOnly: true})).rejects.toThrow(/on another database.*NUXT_API_ONLY/)
            await expect(routeToApi(eventOf('/api/statuses'), {})).rejects.toMatchObject({statusCode: 503})
        } finally {
            await new Promise<void>(resolve => api.close(() => resolve()))
        }
    })

    it('on, leaves what the API doesn\'t serve to the routes here', async () => {
        expect(await routeToApi(eventOf('/api/sessions'), {apiOnly: true})).toBeUndefined()
        expect(await routeToApi(eventOf('/api/projects/p/issues/P-1/start', 'POST'), {apiOnly: true})).toBeUndefined()
    })
})
