// The one-time sign-in links App settings' QR code carries (ORR-837): scanned, a phone is signed in as the owner with a
// login of its own, nothing to type. Each is good once, for a few minutes, and kept only in memory, hashed, so a restart
// ends them all. A fresh one is made each time App settings shows the code.
import {createHash, randomBytes} from 'node:crypto'

export {PHONE_LOGIN} from '#shared/phone'
export const LINK_MINUTES = 5
const MAX = 20
const links = new Map<string, {person: string, expires: number}>()
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** A new link's token for `person`, and when it stops working. */
export function makeSignInLink(person: string, now = Date.now()): {token: string, expires_at: string} {
    for (const [id, link] of links) if (link.expires <= now) links.delete(id)
    // The oldest go first, so a page left open making them can't fill memory.
    for (const id of [...links.keys()].slice(0, Math.max(links.size - MAX + 1, 0))) links.delete(id)
    const token = randomBytes(24).toString('base64url')
    const expires = now + LINK_MINUTES * 60_000
    links.set(hash(token), {person, expires})
    return {token, expires_at: new Date(expires).toISOString()}
}

/** Whose a link is, using it up: nobody's once used, expired or never made. */
export function takeSignInLink(token: unknown, now = Date.now()): string | undefined {
    if (typeof token !== 'string' || !/^[\w-]{20,64}$/.test(token)) return
    const id = hash(token)
    const link = links.get(id)
    links.delete(id)
    return link && link.expires > now ? link.person : undefined
}

/** Ends every link not yet used (tests). */
export const clearSignInLinks = () => links.clear()
