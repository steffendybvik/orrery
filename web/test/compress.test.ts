import {Socket} from 'node:net'
import {IncomingMessage, ServerResponse} from 'node:http'
import {gunzipSync} from 'node:zlib'
import {createEvent} from 'h3'
import {beforeAll, describe, expect, it, vi} from 'vitest'

// API answers go gzipped to a browser that takes it (ORR-766).
let compressed: typeof import('../server/plugins/compress').compressed

beforeAll(async () => {
    vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
    compressed = (await import('../server/plugins/compress')).compressed
})

function eventOf(path: string, encoding = 'gzip, deflate, br') {
    const req = new IncomingMessage(new Socket())
    req.url = path
    req.method = 'GET'
    if (encoding) req.headers['accept-encoding'] = encoding
    return createEvent(req, new ServerResponse(req))
}

const big = {issues: Array.from({length: 200}, (_, i) => ({id: `ORR-${i}`, title: 'Sweep the porch'}))}

describe('an API answer', () => {
    it('goes gzipped as JSON when the browser takes gzip', () => {
        const event = eventOf('/api/projects')
        const body = compressed(event, big)!
        expect(JSON.parse(gunzipSync(body).toString())).toEqual(big)
        expect(event.node.res.getHeader('content-encoding')).toBe('gzip')
        expect(event.node.res.getHeader('content-type')).toBe('application/json')
        expect(String(event.node.res.getHeader('vary'))).toContain('Accept-Encoding')
    })

    it('goes as it is to a client that takes no gzip', () => {
        for (const encoding of ['', 'identity', 'br']) expect(compressed(eventOf('/api/projects', encoding), big)).toBeUndefined()
    })

    it('goes as it is when small, or not an API answer', () => {
        expect(compressed(eventOf('/api/settings'), {theme: 'dark'})).toBeUndefined()
        expect(compressed(eventOf('/p/orrery'), big)).toBeUndefined()
    })

    it('leaves streams, files, web responses and errors to h3', () => {
        const event = eventOf('/api/events')
        for (const body of [Buffer.from('x'.repeat(4096)), new Response('x'.repeat(4096)), new Error('no'), {pipe: () => {}}, {end: () => {}}, 'x'.repeat(4096), null, undefined]) {
            expect(compressed(event, body)).toBeUndefined()
        }
        expect(event.node.res.getHeader('content-encoding')).toBeUndefined()
    })

    it('keeps a content type a handler set', () => {
        const event = eventOf('/api/llms')
        event.node.res.setHeader('content-type', 'application/problem+json')
        compressed(event, big)
        expect(event.node.res.getHeader('content-type')).toBe('application/problem+json')
    })
})
