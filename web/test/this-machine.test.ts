import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {H3Event} from 'h3'

// Whether a request came from the machine orrery runs on (ORR-421).
let machine: typeof import('../server/utils/this-machine')

beforeEach(async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({database: ':memory:'}))
    vi.resetModules()
    machine = await import('../server/utils/this-machine')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

const request = (headers: Record<string, string>, remoteAddress?: string) =>
    ({node: {req: {headers: {host: 'localhost:9000', ...headers}, socket: {remoteAddress}}}}) as unknown as H3Event

describe('a request from this machine', () => {
    it('is one reaching it by a local name over a loopback connection', () => {
        for (const host of ['localhost:9010', '127.0.0.1:9010', '[::1]:9010', 'orrery.localhost']) expect(machine.fromThisMachine(request({host}, '127.0.0.1'))).toBe(true)
        expect(machine.fromThisMachine(request({}, '::ffff:127.0.0.1'))).toBe(true)
        expect(machine.fromThisMachine(request({}, '192.168.1.20'))).toBe(false)
        for (const host of ['orrery.example.com', '192.168.1.20:9010', 'mac.lan', 'localhost.evil.com']) expect(machine.fromThisMachine(request({host}, '127.0.0.1'))).toBe(false)
    })

    it("isn't one from another machine, whatever name it says it reached orrery by (the Host header is the caller's)", () => {
        for (const from of ['192.168.1.20', '::ffff:192.168.1.20', '10.0.0.7', '']) expect(machine.fromThisMachine(request({}, from))).toBe(false)
    })

    it("isn't one a reverse proxy on this machine passed on, whoever sent it (ORR-457)", () => {
        for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip']) {
            expect(machine.fromThisMachine(request({[header]: '203.0.113.9'}, '127.0.0.1'))).toBe(false)
        }
    })

    it("reads nuxt dev's own forwarded address, the last one, as a request there has no socket address", () => {
        expect(machine.fromThisMachine(request({'x-forwarded-for': '127.0.0.1'}))).toBe(true)
        expect(machine.fromThisMachine(request({'x-forwarded-for': '127.0.0.1, ::1'}))).toBe(true)
        expect(machine.fromThisMachine(request({'x-forwarded-for': '203.0.113.9'}))).toBe(false)
        // What the client sent comes first; the proxy's own word is the last.
        expect(machine.fromThisMachine(request({'x-forwarded-for': '127.0.0.1, 192.168.1.20'}))).toBe(false)
    })

    it('in Docker, where every request comes through the bridge, is one only while orrery is published on loopback', () => {
        vi.stubEnv('ORRERY_IMAGE', '1')
        for (const [listenHost, expected] of [['127.0.0.1', true], ['0.0.0.0', false], ['', false]] as const) {
            vi.stubGlobal('useRuntimeConfig', () => ({database: ':memory:', listenHost}))
            expect(machine.fromThisMachine(request({}, '172.17.0.1'))).toBe(expected)
        }
    })
})
