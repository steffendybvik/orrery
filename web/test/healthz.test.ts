import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {IncomingMessage, ServerResponse} from 'node:http'
import {Socket} from 'node:net'
import {createEvent} from 'h3'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {apiStarted} from '../server/utils/api-router'

// `/healthz` asks the Rust API too (ORR-1188): a container whose API died showed healthy while every board request
// failed, so Docker and whatever watches it never restarted it.

type Handler = (event: ReturnType<typeof createEvent>) => Promise<{ok: boolean}>
let healthz: Handler

function eventOf() {
    const req = new IncomingMessage(new Socket())
    req.url = '/healthz'
    req.method = 'GET'
    return createEvent(req, new ServerResponse(req))
}

async function asked() {
    const event = eventOf()
    const body = await healthz(event)
    return {status: event.node.res.statusCode, body}
}

/** A child process standing in for the API: it answers `/health` with {ok: true}, and says where once it listens. */
async function childApi() {
    const child = spawn(process.execPath, ['-e', `
        const server = require('node:http').createServer((req, res) => {
            res.statusCode = req.url === '/health' ? 200 : 404
            res.end(JSON.stringify({ok: true}))
        })
        server.listen(0, '127.0.0.1', () => console.log(server.address().port))
    `], {stdio: ['ignore', 'pipe', 'inherit']})
    const [chunk] = await once(child.stdout!, 'data') as [Buffer]
    return {child, url: `http://127.0.0.1:${chunk.toString().trim()}`}
}

beforeAll(async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    vi.stubGlobal('setResponseStatus', (event: ReturnType<typeof createEvent>, status: number) => event.node.res.statusCode = status)
    healthz = (await import('../server/routes/healthz.get')).default as unknown as Handler
})

afterEach(() => apiStarted(null))
afterAll(() => vi.unstubAllGlobals())

describe('/healthz', () => {
    it('answers ok while the API answers, and 503 once it is killed', async () => {
        const {child, url} = await childApi()
        try {
            apiStarted({url, token: 't'.repeat(24)})
            expect(await asked()).toEqual({status: 200, body: {ok: true}})
            child.kill('SIGKILL')
            await once(child, 'exit')
            expect(await asked()).toEqual({status: 503, body: {ok: false}})
        } finally {
            child.kill('SIGKILL')
        }
    })

    it('answers 503 with no API running at all', async () => {
        expect(await asked()).toEqual({status: 503, body: {ok: false}})
    })
})
