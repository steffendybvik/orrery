// The phone's own port (ORR-837). orrery listens twice: the address the sessions use stays as it is (on loopback, trusted,
// with no keys), and a second port, the one a phone opens, always asks for a login. A request is told apart by the port it
// came in on inside the server, never by who sent it, as in Docker on a Mac every caller looks the same.
import type {H3Event} from 'h3'

const port = (value: unknown) => {
    const n = Number(String(value ?? '').trim())
    return Number.isInteger(n) && n > 0 && n < 65_536 ? n : 0
}

/** The port the phone's listener listens on, or 0 for none: ORRERY_PHONE_LISTEN (the container's), else ORRERY_PHONE_PORT. */
export function phoneListenPort(): number {
    return port(useRuntimeConfig().phoneListen || process.env.ORRERY_PHONE_LISTEN) || port(process.env.ORRERY_PHONE_PORT)
}

/** The port the phone opens: the one it's published on, else the one it listens on. */
export function phonePublishedPort(): number {
    return port(useRuntimeConfig().phonePort) || port(process.env.ORRERY_PHONE_PORT) || phoneListenPort()
}

/** The address the phone port is published on: compose's ORRERY_PHONE_HOST, else every address. */
export function phoneHost(): string {
    return String(useRuntimeConfig().phoneHost || process.env.ORRERY_PHONE_HOST || '0.0.0.0').trim()
}

/** Whether this request came in on the phone's port. */
export function viaPhone(event: H3Event): boolean {
    const listen = phoneListenPort()
    return !!listen && event.node.req.socket?.localPort === listen
}
