import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {H3Event} from 'h3'

// Whether a request came from the machine orrery runs on, for moving the database and setting the backups (ORR-421).
let move: typeof import('../server/utils/move')

beforeEach(async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({database: ':memory:'}))
    vi.resetModules()
    move = await import('../server/utils/move')
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const request = (headers: Record<string, string>, remoteAddress?: string) =>
    ({node: {req: {headers: {host: 'localhost:9000', ...headers}, socket: {remoteAddress}}}}) as unknown as H3Event

describe('a request from this machine', () => {
    it('is one reaching it by a local name over a loopback connection', () => {
        expect(move.fromThisMachine(request({}, '127.0.0.1'))).toBe(true)
        expect(move.fromThisMachine(request({}, '192.168.1.20'))).toBe(false)
        expect(move.fromThisMachine(request({host: 'orrery.example.com'}, '127.0.0.1'))).toBe(false)
    })

    it("isn't one a reverse proxy on this machine passed on, whoever sent it (ORR-457)", () => {
        for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip']) {
            expect(move.fromThisMachine(request({[header]: '203.0.113.9'}, '127.0.0.1'))).toBe(false)
        }
    })

    it("reads nuxt dev's own forwarded address, as a request there has no socket address", () => {
        expect(move.fromThisMachine(request({'x-forwarded-for': '127.0.0.1'}))).toBe(true)
        expect(move.fromThisMachine(request({'x-forwarded-for': '203.0.113.9'}))).toBe(false)
    })
})
