import {Readable} from 'node:stream'
import {createError} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// How much of a body orrery will hold in memory (ORR-753); its h3 helpers are Nitro auto-imports.
type Event = {method: string, path: string, headers: Record<string, string>, node: {req: Readable}, _requestBody?: Buffer}
let guard: (event: Event) => Promise<void>

beforeEach(async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('createError', createError)
    vi.resetModules()
    guard = (await import('../server/middleware/big-bodies')).default as unknown as typeof guard
})

afterEach(() => vi.unstubAllGlobals())

const MB = 1024 * 1024
const eventOf = (path: string, headers: Record<string, string>, chunks: Buffer[] = [], method = 'POST'): Event =>
    ({method, path, headers, node: {req: Readable.from(chunks)}})

/** The status the guard refuses the request with, or nothing when it lets it through. */
const refused = (event: Event) => guard(event).then(() => undefined, error => (error as {statusCode: number}).statusCode)

describe("a request's body", () => {
    it('is refused by its length, before anything is read', async () => {
        expect(await refused(eventOf('/api/projects/a/issues', {'content-length': String(33 * MB)}))).toBe(413)
        expect(await refused(eventOf('/api/projects/a/issues', {'content-length': String(32 * MB)}))).toBeUndefined()
    })

    it('is held to very little on the open login routes, however the path is spelled', async () => {
        for (const path of ['/api/auth/login', '/api//auth/login', '/API/auth/login?x=1', '/api/auth/%6cogin']) {
            expect(await refused(eventOf(path, {'content-length': String(65 * 1024)}))).toBe(413)
        }
        expect(await refused(eventOf('/api/auth/login', {'content-length': '200'}))).toBeUndefined()
    })

    it('may be as large as a board on the routes that take one', async () => {
        for (const path of ['/api/projects/upload', '/api/projects/a/import']) {
            expect(await refused(eventOf(path, {'content-length': String(200 * MB)}))).toBeUndefined()
            expect(await refused(eventOf(path, {'content-length': String(257 * MB)}))).toBe(413)
        }
    })

    it('is counted as it comes when it gives no length', async () => {
        const chunked = {'transfer-encoding': 'chunked'}
        expect(await refused(eventOf('/api/auth/login', chunked, [Buffer.alloc(40 * 1024), Buffer.alloc(40 * 1024)]))).toBe(413)
        const fine = eventOf('/api/projects/a/issues', chunked, [Buffer.from('{"title":'), Buffer.from('"Jam"}')])
        expect(await refused(fine)).toBeUndefined()
        expect(fine._requestBody?.toString()).toBe('{"title":"Jam"}')
    })

    it('is left alone on a read', async () => {
        expect(await refused(eventOf('/api/projects', {'content-length': String(33 * MB)}, [], 'GET'))).toBeUndefined()
    })
})
