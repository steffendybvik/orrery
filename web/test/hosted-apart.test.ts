import {createError} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {asOrigin} from '../server/utils/origins'

// A frontend hosted apart from its server (ORR-667): the CORS answer to the sites listed in NUXT_ALLOWED_ORIGINS, and
// NUXT_PAGES=off for a server that serves its API alone. Through the real middleware, on events standing in for
// requests; Nitro's auto-imports are stood in for here. writes.test.ts holds the listed sites' writes.
type Event = {method: string, path: string, headers: Record<string, string>, answer: Record<string, string>, status?: number}
type Handler = (event: Event) => unknown

let config: Record<string, unknown>
let cors: Handler
let pages: Handler

beforeEach(async () => {
    config = {allowedOrigins: '', pages: ''}
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('setResponseHeaders', (event: Event, headers: Record<string, string>) => Object.assign(event.answer, headers))
    vi.stubGlobal('setResponseStatus', (event: Event, status: number) => event.status = status)
    vi.stubGlobal('createError', createError)
    vi.resetModules()
    cors = (await import('../server/middleware/0-cors')).default as unknown as Handler
    pages = (await import('../server/middleware/0-pages')).default as unknown as Handler
})

afterEach(() => vi.unstubAllGlobals())

const request = (method: string, path: string, headers: Record<string, string> = {}): Event => ({method, path, headers, answer: {}})
const LISTED = 'https://app.example.com'

describe('CORS for a listed site', () => {
    beforeEach(() => config.allowedOrigins = `${LISTED}, http://127.0.0.1:3392`)

    it('answers its preflight with that one origin, its credentials, and what orrery’s page sends', () => {
        const event = request('OPTIONS', '/api/projects/atlas/issues', {origin: LISTED, 'access-control-request-method': 'PATCH'})
        expect(cors(event)).toBe('')
        expect(event.status).toBe(204)
        expect(event.answer).toMatchObject({
            'Access-Control-Allow-Origin': LISTED,
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Orrery-Actor',
            Vary: 'Origin',
        })
    })

    it('lets it read every answer under /api, and passes the request on', () => {
        for (const [method, path] of [['GET', '/api/projects'], ['POST', '/api/projects/atlas/issues'], ['GET', '/api/events?patch=1'], ['GET', '/api']]) {
            const event = request(method!, path!, {origin: 'http://127.0.0.1:3392'})
            expect(cors(event)).toBeUndefined()
            expect(event.answer['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:3392')
            expect(event.status).toBeUndefined()
        }
    })

    it('says nothing outside /api', () => {
        for (const path of ['/', '/channel/channel.mjs', '/connect/atlas.md', '/apix']) {
            const event = request('GET', path, {origin: LISTED})
            cors(event)
            expect(event.answer).toEqual({})
        }
    })
})

describe('CORS for every other site', () => {
    it('says nothing, so the browser keeps the answer from it, and its preflight goes on to be refused', () => {
        config.allowedOrigins = LISTED
        for (const origin of ['https://evil.example', 'https://app.example.com.evil.example', 'http://app.example.com', 'null', '']) {
            const preflight = request('OPTIONS', '/api/projects', {origin, 'access-control-request-method': 'POST'})
            expect(cors(preflight)).toBeUndefined()
            expect(preflight.answer).toEqual({})
            const read = request('GET', '/api/projects', {origin})
            cors(read)
            expect(read.answer).toEqual({})
        }
    })

    it('answers no site while nothing is listed, the default', () => {
        const event = request('OPTIONS', '/api/projects', {origin: LISTED, 'access-control-request-method': 'POST'})
        expect(cors(event)).toBeUndefined()
        expect(event.answer).toEqual({})
    })
})

describe('an origin in the list', () => {
    it('is a plain http(s) scheme, host and port, as a browser sends it', () => {
        expect(asOrigin('https://App.Example.com')).toBe('https://app.example.com')
        expect(asOrigin(' https://app.example.com/ ')).toBe('https://app.example.com')
        expect(asOrigin('http://127.0.0.1:3392')).toBe('http://127.0.0.1:3392')
        for (const value of ['*', 'null', '', 'app.example.com', 'ftp://app.example.com', 'https://app.example.com/path',
            'https://user:pw@app.example.com', 'https://app.example.com?x=1', 'https://app.example.com#x']) {
            expect(asOrigin(value)).toBeUndefined()
        }
    })
})

describe('NUXT_PAGES=off', () => {
    const answered = (path: string) => {
        try {
            pages(request('GET', path))
            return true
        } catch (error) {
            return (error as {statusCode: number}).statusCode
        }
    }

    it('keeps the API and what the sessions’ machines fetch', () => {
        config.pages = 'off'
        for (const path of ['/api', '/api/projects', '/channel/channel.mjs', '/connect/atlas.md', '/healthz', '/llms.txt', '/llms-full.txt', '/API/projects']) {
            expect(answered(path)).toBe(true)
        }
    })

    it('serves no page', () => {
        config.pages = 'OFF'
        for (const path of ['/', '/login', '/p/atlas/issues/ATL-1', '/settings', '/apix', '/healthz/x', '/%61pix']) {
            expect(answered(path)).toBe(404)
        }
    })

    it('serves every page while unset, the default', () => {
        for (const path of ['/', '/login', '/settings']) expect(answered(path)).toBe(true)
    })
})
