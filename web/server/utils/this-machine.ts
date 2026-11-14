// Whether a request came from the machine orrery runs on (ORR-421): what only someone at that machine may do, such as
// trusting a request without a login.
import type {H3Event} from 'h3'
import {getRequestHost} from 'h3'
import {inDocker} from './host-paths'
import {viaPhone} from './phone-port'

/** The names only this machine reaches orrery by. */
const THIS_MACHINE = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i
/** A loopback address, as a connection comes from (`::ffff:127.0.0.1` over IPv6) or as orrery is published on. */
export const LOOPBACK = /^(127(\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(\.\d{1,3}){3}|localhost)$/i

/** Whether the request came from the machine orrery runs on. The name it was reached by has to be this machine's, but
 * that's the `Host` header, which the caller chooses (ORR-421), so the connection has to say so too: outside Docker, it
 * comes from a loopback address (see `clientAddress`); in Docker, where every request comes through the bridge, orrery has to be published on
 * loopback alone (`ORRERY_HOST`, 127.0.0.1 by default, which compose passes in as NUXT_LISTEN_HOST). */
export function fromThisMachine(event: H3Event): boolean {
    // The phone's port is the network's, whatever Host it's sent (ORR-837).
    if (viaPhone(event)) return false
    if (!THIS_MACHINE.test(getRequestHost(event).replace(/:\d+$/, ''))) return false
    if (proxied(event)) return false
    if (inDocker()) return LOOPBACK.test(String(useRuntimeConfig().listenHost ?? ''))
    return LOOPBACK.test(clientAddress(event))
}

/** A reverse proxy on this machine makes every request come from it, whoever sent it: one it passes on says so in these
 * headers, so it isn't taken as local (ORR-457). `nuxt dev` adds its own, to a request with no socket address. */
export function proxied(event: H3Event): boolean {
    const {headers} = event.node.req
    return !!event.node.req.socket?.remoteAddress && ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'].some(name => headers[name] !== undefined)
}

/** Where the connection comes from. `nuxt dev` hands each request to its server over a local socket, which has no
 * address, and puts the client's last in `X-Forwarded-For` (after any the client sent itself), so it's read there then. */
function clientAddress(event: H3Event): string {
    const socket = event.node.req.socket?.remoteAddress
    if (socket) return socket
    const forwarded = event.node.req.headers['x-forwarded-for']
    return String(Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').at(-1)?.trim() ?? ''
}
