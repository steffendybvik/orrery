import {createError} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The guard against the browser being used against orrery; its h3 helpers are Nitro auto-imports.
type Event = {method: string, path: string, headers: Record<string, string>}
let guard: (event: Event) => void
let allowedOrigins = ''

beforeEach(async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRequestHost', (event: Event) => event.headers.host)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('createError', createError)
    vi.stubGlobal('useRuntimeConfig', () => ({allowedHosts: '', allowedOrigins}))
    vi.resetModules()
    guard = (await import('../server/middleware/writes')).default as unknown as typeof guard
})

afterEach(() => {
    vi.unstubAllGlobals()
    allowedOrigins = ''
})

/** The status the guard refuses the request with, or nothing when it lets it through. */
function refused(method: string, path: string, headers: Record<string, string> = {}): number | undefined {
    try {
        guard({method, path, headers: {host: 'localhost:9000', ...headers}})
    } catch (error) {
        return (error as {statusCode: number}).statusCode
    }
}

describe('writes', () => {
    it('come from orrery’s own page, or from no page at all', () => {
        expect(refused('POST', '/api/projects/greenhouse/issues')).toBeUndefined()
        expect(refused('POST', '/api/projects/greenhouse/issues', {origin: 'http://localhost:9000'})).toBeUndefined()
        expect(refused('POST', '/api/projects/greenhouse/issues', {origin: 'https://evil.example'})).toBe(403)
        expect(refused('POST', '/api/projects/greenhouse/issues', {origin: 'null'})).toBe(403)
    })

    it('with an Origin that isn’t a URL are refused, not an error', () => {
        expect(refused('POST', '/api/projects/greenhouse/issues', {origin: 'foo'})).toBe(403)
    })
})

describe('a site listed in NUXT_ALLOWED_ORIGINS (ORR-667)', () => {
    const write = (origin: string) => refused('POST', '/api/projects/greenhouse/issues', {origin})

    it('can write, as orrery’s page hosted there', () => {
        allowedOrigins = 'https://app.example.com, http://127.0.0.1:3392'
        expect(write('https://app.example.com')).toBeUndefined()
        expect(write('http://127.0.0.1:3392')).toBeUndefined()
        for (const method of ['PUT', 'PATCH', 'DELETE']) {
            expect(refused(method, '/api/projects/greenhouse', {origin: 'https://app.example.com'})).toBeUndefined()
        }
    })

    it('is matched whole: no other site, port, scheme or lookalike, and never `null`', () => {
        allowedOrigins = 'https://app.example.com'
        for (const origin of ['https://evil.example', 'https://app.example.com.evil.example', 'https://app.example.com:8443',
            'http://app.example.com', 'https://sub.app.example.com', 'null', 'https://app.example.com/']) {
            expect(write(origin)).toBe(403)
        }
        for (const method of ['PUT', 'PATCH', 'DELETE']) {
            expect(refused(method, '/api/projects/greenhouse', {origin: 'https://evil.example'})).toBe(403)
        }
    })

    it('still sends its body as JSON, and can’t open a session’s stream', () => {
        allowedOrigins = 'https://app.example.com'
        expect(refused('POST', '/api/projects/greenhouse/issues', {origin: 'https://app.example.com', 'content-length': '5', 'content-type': 'text/plain'})).toBe(415)
        expect(refused('GET', '/api/signals/stream?session=abc', {origin: 'https://app.example.com', 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'empty'})).toBe(403)
    })

    it('lists nothing by default', () => {
        expect(write('https://app.example.com')).toBe(403)
    })

    it('ignores what isn’t an origin, and a wildcard', () => {
        allowedOrigins = '*, null, https://*.example.com, https://app.example.com/path, ftp://files.example.com'
        for (const origin of ['https://app.example.com', 'https://evil.example', 'null', 'ftp://files.example.com']) expect(write(origin)).toBe(403)
    })
})

describe('the names it answers to', () => {
    it('are this machine’s: localhost, an IP, and its Bonjour name on the Wi-Fi (ORR-874)', () => {
        for (const host of ['localhost:9000', 'app.localhost', '192.168.1.20:19000', 'steffens-mac.local:19010', 'Mac.local']) {
            expect(refused('GET', '/api/issues', {host})).toBeUndefined()
        }
    })

    it('aren’t another site’s, even one that ends like a local name', () => {
        for (const host of ['evil.example', 'mac.local.evil.example', 'a.b.local', '-mac.local', 'local', '.local']) {
            expect(refused('GET', '/api/issues', {host})).toBe(403)
        }
    })
})

describe('a session’s stream', () => {
    const stream = '/api/projects/greenhouse/signals/stream?session=abc&channel=no'

    it('opens for the channel, the launcher and curl, which send no Sec-Fetch headers', () => {
        expect(refused('GET', stream)).toBeUndefined()
        expect(refused('GET', '/api/projects/greenhouse/launches/stream')).toBeUndefined()
    })

    it('doesn’t open for a picture, on another site or in orrery’s own page', () => {
        expect(refused('GET', stream, {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image'})).toBe(403)
        // The router serves a stream with a slash on the end too (ORR-752).
        for (const path of ['/api/projects/greenhouse/signals/stream/?session=abc', '/api/projects/greenhouse/launches/stream/', '/api/launches/stream?serve=[]', '/api/signals/stream/?session=abc']) {
            expect(refused('GET', path, {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image'})).toBe(403)
        }
        expect(refused('GET', stream, {'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image'})).toBe(403)
    })

    it('doesn’t open for another site’s script', () => {
        expect(refused('GET', stream, {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty', origin: 'https://evil.example'})).toBe(403)
        expect(refused('GET', stream, {'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'empty'})).toBe(403)
    })

    it('leaves the other reads alone', () => {
        expect(refused('GET', '/api/projects/greenhouse/issues', {'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image'})).toBeUndefined()
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
