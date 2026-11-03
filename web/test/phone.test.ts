import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Where App settings says a phone can open orrery (ORR-833): from what it listens on, ORRERY_PHONE_URL, this machine's
// networks outside Docker, and in Docker a launcher's report of its machine's, as the container sees only its own.
let docker = false
let config: Record<string, unknown>
vi.mock('../server/utils/backup-choice', () => ({inDocker: () => docker}))
vi.mock('node:os', async original => ({
    ...await original<object>(),
    networkInterfaces: () => ({
        lo0: [{family: 'IPv4', address: '127.0.0.1', internal: true}],
        en0: [{family: 'IPv4', address: '192.168.178.90', internal: false}, {family: 'IPv6', address: 'fe80::1', internal: false}],
        utun4: [{family: 'IPv4', address: '100.64.0.7', internal: false}],
        en5: [{family: 'IPv4', address: '169.254.10.2', internal: false}],
        bridge100: [{family: 'IPv4', address: '192.168.64.1', internal: false}],
    }),
}))

const {ipv4List, phoneLinks, reachable} = await import('../server/utils/phone')
const {addPicker} = await import('../server/utils/connects')

/** A request to the page at `host`, on a server outside Docker bound to `bound`. */
const request = (bound: string, host = 'localhost:9010') => ({headers: {host}, node: {req: {headers: {host}, socket: {server: {address: () => ({address: bound})}}}}}) as never
const urls = (event: never) => phoneLinks(event).addresses.map(a => a.url)

beforeEach(() => {
    docker = false
    config = {listenHost: '', phoneUrl: ''}
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('getRequestHost', (event: {headers: {host: string}}) => event.headers.host)
})
afterEach(() => vi.unstubAllGlobals())

describe('the addresses a phone could reach', () => {
    it('are IPv4, and not loopback, link-local or every address', () => {
        expect(['192.168.178.90', '10.0.0.4', '100.64.0.7'].every(reachable)).toBe(true)
        expect(['127.0.0.1', '0.0.0.0', '169.254.1.1', '::1', 'mac.local', '300.1.1.1', '224.0.0.1'].some(reachable)).toBe(false)
    })

    it("are kept from a launcher's report only when they're addresses, at most eight", () => {
        expect(ipv4List('192.168.1.5, 127.0.0.1,evil<script>,192.168.1.5,10.0.0.2')).toEqual(['192.168.1.5', '10.0.0.2'])
        expect(ipv4List(Array.from({length: 12}, (_, i) => `10.0.0.${i + 1}`).join(','))).toHaveLength(8)
        expect(ipv4List(undefined)).toEqual([])
    })
})

describe('outside Docker', () => {
    it("on loopback, says it's only this machine's, with where it would be", () => {
        const links = phoneLinks(request('127.0.0.1'))
        expect(links.reach).toBe('loopback')
        expect(links.addresses.map(a => a.url)).toEqual(['http://192.168.178.90:9010', 'http://100.64.0.7:9010'])
    })

    it("on every address, is this machine's networks, at the port the page was opened on", () => {
        expect(phoneLinks(request('0.0.0.0')).reach).toBe('network')
        expect(urls(request('::', 'localhost:3400'))).toEqual(['http://192.168.178.90:3400', 'http://100.64.0.7:3400'])
    })

    it('on one address, is that address alone', () => {
        expect(urls(request('100.64.0.7'))).toEqual(['http://100.64.0.7:9010'])
    })
})

describe('in Docker', () => {
    beforeEach(() => docker = true)

    it("on loopback is only this machine's, and doesn't offer the container's own networks", () => {
        config.listenHost = '127.0.0.1'
        expect(phoneLinks(request('0.0.0.0'))).toMatchObject({reach: 'loopback', docker: true, addresses: []})
    })

    it("on every address takes the launcher's report of its machine, leaving out Docker's own networks", () => {
        config.listenHost = '0.0.0.0'
        const done = addPicker('mac', ['192.168.178.90', '192.168.65.3', '172.17.0.1'])
        try {
            expect(phoneLinks(request('0.0.0.0')).addresses).toEqual([{url: 'http://192.168.178.90:9010', from: 'launcher', machine: 'mac'}])
        } finally {
            done()
        }
        expect(urls(request('0.0.0.0'))).toEqual([])
    })

    it('on a VPN address is that address, after ORRERY_PHONE_URL', () => {
        Object.assign(config, {listenHost: '100.64.0.7', phoneUrl: 'https://mac.my-vpn.net/'})
        expect(phoneLinks(request('0.0.0.0')).addresses).toEqual([
            {url: 'https://mac.my-vpn.net', from: 'setting'},
            {url: 'http://100.64.0.7:9010', from: 'host'},
        ])
    })

    it("ignores an ORRERY_PHONE_URL that isn't a web address", () => {
        Object.assign(config, {listenHost: '0.0.0.0', phoneUrl: 'javascript:alert(1)'})
        expect(urls(request('0.0.0.0'))).toEqual([])
    })
})
