// Opening orrery on a phone (ORR-833): where App settings says it can be reached from another device, and how far it's
// open now. Made on the server, as only it knows what it listens on; the page draws the QR code itself.

/** Where an address came from: `ORRERY_PHONE_URL`, the address `ORRERY_HOST` publishes it on, this machine's own
 * networks (outside Docker), or a launcher's report of its machine's (in Docker, which sees only its container's). */
export type PhoneSource = 'setting' | 'host' | 'machine' | 'launcher'

export interface PhoneAddress {
    url: string
    from: PhoneSource
    /** The launcher's machine, for one it reported. */
    machine?: string
}

export interface PhoneLinks {
    /** `loopback`: only this machine reaches it, so `addresses` are where it would be once opened up. */
    reach: 'loopback' | 'network'
    docker: boolean
    /** The port the page was opened on, which is the one published. */
    port: string
    /** The phone has a port of its own (ORR-837), which always asks for a login: the QR code signs it in. */
    phone: boolean
    addresses: PhoneAddress[]
}
