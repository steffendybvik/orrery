// Where a phone can open this orrery (ORR-833), for App settings' link and QR code. orrery knows what it listens on: in
// Docker the address compose publishes it on (`listenHost`), and outside it the one it bound to. With every address
// (`0.0.0.0`) it's this machine's networks, which in Docker only a launcher on the machine can say.
import {networkInterfaces} from 'node:os'
import type {H3Event} from 'h3'
import type {PhoneAddress, PhoneLinks} from '#shared/phone'
import {inDocker} from './backup-choice'
import {launcherAddresses} from './connects'
import {LOOPBACK} from './move'
import {phoneHost, phonePublishedPort} from './phone-port'

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const EVERY = /^(0\.0\.0\.0|::|\[::\]|)$/

/** An address another device could reach: IPv4, not loopback, link-local or every address. */
export function reachable(address: string): boolean {
    const parts = IPV4.exec(address)?.slice(1).map(Number)
    if (!parts || parts.some(n => n > 255)) return false
    const [a, b] = parts as [number, number]
    return a !== 127 && a !== 0 && !(a === 169 && b === 254) && a < 224
}

/** A launcher's comma-separated addresses, as it reports them, keeping only those a phone could reach, at most 8. */
export function ipv4List(value: unknown): string[] {
    if (typeof value !== 'string') return []
    return [...new Set(value.split(',').map(a => a.trim()).filter(reachable))].slice(0, 8)
}

/** Docker's own networks (172.17/16 and up, 192.168.65/24 on a Mac) mean nothing to a phone; a home or VPN one does. */
const dockersOwn = (address: string) => /^172\.(1[6-9]|2\d|3[01])\./.test(address) || address.startsWith('192.168.65.')

/** A virtual machine's or container's network on this machine (a Mac's `bridge100`, Docker's), which a phone can't
 * reach. The launcher leaves the same out. */
const VIRTUAL = /^(bridge|vmnet|vboxnet|docker|veth|br-|virbr)/

/** This machine's addresses on its networks, outside Docker. */
function machineAddresses(): string[] {
    return Object.entries(networkInterfaces()).filter(([name]) => !VIRTUAL.test(name)).flatMap(([, all]) => all ?? [])
        .flatMap(i => i.family === 'IPv4' && !i.internal ? [i.address] : []).filter(reachable)
}

/** What the server listens on: compose's address in Docker, else the one it bound to (a socket's path is `nuxt dev`'s). */
function listening(event: H3Event): string {
    if (inDocker()) return String(useRuntimeConfig().listenHost ?? '')
    const server = (event.node.req.socket as {server?: {address?: () => unknown}} | undefined)?.server
    const bound = server?.address?.()
    if (typeof bound === 'string') return '127.0.0.1'
    return String((bound as {address?: string} | null | undefined)?.address ?? '')
}

export function phoneLinks(event: H3Event): PhoneLinks {
    const docker = inDocker()
    // With the phone's own port (ORR-837), that's where a phone goes; else the one the page was opened on.
    const phone = phonePublishedPort()
    const port = phone ? String(phone) : /:(\d+)$/.exec(getRequestHost(event))?.[1] ?? ''
    const at = (address: string) => `http://${address}${port ? `:${port}` : ''}`
    const bound = phone ? phoneHost() : listening(event)
    const reach = LOOPBACK.test(bound) ? 'loopback' : 'network'
    const found: PhoneAddress[] = []
    const setting = String(useRuntimeConfig().phoneUrl ?? '').trim().replace(/\/+$/, '')
    if (/^https?:\/\/[^\s/]+/.test(setting)) found.push({url: setting, from: 'setting'})
    if (reachable(bound)) found.push({url: at(bound), from: 'host'})
    else if (EVERY.test(bound) || reach === 'loopback') {
        if (!docker) for (const address of machineAddresses()) found.push({url: at(address), from: 'machine'})
        else for (const {host, addresses} of launcherAddresses()) {
            for (const address of addresses.filter(a => !dockersOwn(a))) found.push({url: at(address), from: 'launcher', ...host ? {machine: host} : {}})
        }
    }
    const seen = new Set<string>()
    return {reach, docker, port, phone: !!phone, addresses: found.filter(({url}) => !seen.has(url) && seen.add(url))}
}
