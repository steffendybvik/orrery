import {createError} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The guard against the browser being used against Orrery; its h3 helpers are Nitro auto-imports.
type Event = {method: string, path: string, headers: Record<string, string>}
let guard: (event: Event) => void

beforeEach(async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRequestHost', (event: Event) => event.headers.host)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('createError', createError)
    vi.stubGlobal('useRuntimeConfig', () => ({allowedHosts: ''}))
    vi.resetModules()
    guard = (await import('../server/middleware/writes')).default as unknown as typeof guard
})

afterEach(() => vi.unstubAllGlobals())

/** The status the guard refuses the request with, or nothing when it lets it through. */
function refused(method: string, path: string, headers: Record<string, string> = {}): number | undefined {
    try {
        guard({method, path, headers: {host: 'localhost:9000', ...headers}})
    } catch (error) {
        return (error as {statusCode: number}).statusCode
    }
}

describe('writes', () => {
    it('come from Orrery’s own page, or from no page at all', () => {
        expect(refused('POST', '/api/projects/larder/issues')).toBeUndefined()
        expect(refused('POST', '/api/projects/larder/issues', {origin: 'http://localhost:9000'})).toBeUndefined()
        expect(refused('POST', '/api/projects/larder/issues', {origin: 'https://evil.example'})).toBe(403)
        expect(refused('POST', '/api/projects/larder/issues', {origin: 'null'})).toBe(403)
    })

    it('with an Origin that isn’t a URL are refused, not an error', () => {
        expect(refused('POST', '/api/projects/larder/issues', {origin: 'foo'})).toBe(403)
    })
})

describe('a session’s stream', () => {
    const stream = '/api/projects/larder/signals/stream?session=abc&channel=no'

    it('opens for the channel, the launcher and curl, which send no Sec-Fetch headers', () => {
        expect(refused('GET', stream)).toBeUndefined()
        expect(refused('GET', '/api/projects/larder/launches/stream')).toBeUndefined()
    })

    it('doesn’t open for a picture, on another site or in Orrery’s own page', () => {
        expect(refused('GET', stream, {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image'})).toBe(403)
        expect(refused('GET', stream, {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image'})).toBe(403)
    })

    it('doesn’t open for another site’s script', () => {
        expect(refused('GET', stream, {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty', origin: 'https://evil.example'})).toBe(403)
        expect(refused('GET', stream, {'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'empty'})).toBe(403)
    })

    it('leaves the other reads alone', () => {
        expect(refused('GET', '/api/projects/larder/issues', {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image'})).toBeUndefined()
        expect(refused('GET', '/api/events', {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty'})).toBeUndefined()
    })
})

describe('an upload', () => {
    it('too big for any image is refused before its body is read', async () => {
        const {UPLOAD_LIMIT} = await import('../server/utils/store')
        let read = 0
        vi.stubGlobal('UPLOAD_LIMIT', UPLOAD_LIMIT)
        vi.stubGlobal('readBody', async () => void read++)
        vi.stubGlobal('useStore', () => ({createUpload: async () => ({id: 'x'})}))
        vi.stubGlobal('actorOf', async () => ({name: 'skoll', owner: true}))
        vi.stubGlobal('created', (_event: unknown, value: unknown) => value)
        const upload = (await import('../server/api/uploads/index.post')).default as unknown as (event: Event) => Promise<unknown>
        const post = (length: number) => upload({method: 'POST', path: '/api/uploads', headers: {'content-length': String(length)}})
        await expect(post(UPLOAD_LIMIT * 2)).rejects.toMatchObject({statusCode: 413})
        expect(read).toBe(0)
        await expect(post(UPLOAD_LIMIT)).resolves.toEqual({id: 'x'})
        expect(read).toBe(1)
    })
})
