// The one-time sign-in links App settings' QR code carries (ORR-837): scanned, a phone is signed in as the owner with a
// login of its own, nothing to type. Each is good once, for a few minutes, and kept only in memory, hashed, so a restart
// ends them all. A fresh one is made each time App settings shows the code.
// Each link also has a six-letter code shown under the QR (ORR-875), typed into the login page where there's no camera
// to scan with: an app added to an iPhone's home screen keeps cookies apart from Safari's, so the scan's login isn't
// there. Using either the link or its code uses up both. A few wrong codes in a row end every code still open (the QR
// links keep working), so guessing one is out of reach: at most 5 tries against 31⁶ codes per round.
import {createHash, randomBytes, randomInt} from 'node:crypto'

export {PHONE_LOGIN} from '#shared/phone'
export const LINK_MINUTES = 5
export const WRONG_CODES = 5
const MAX = 20
/** No 0/O, 1/I/L: easy to read off a screen and type on a phone. */
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const links = new Map<string, {person: string, expires: number, code?: string}>()
let wrong = 0
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** A code as it's typed: upper case, with spaces and dashes taken out. */
const normalize = (code: string) => code.toUpperCase().replace(/[\s-]/g, '')

/** A new link's token and code for `person`, and when they stop working. */
export function makeSignInLink(person: string, now = Date.now()): {token: string, code: string, expires_at: string} {
    for (const [id, link] of links) if (link.expires <= now) links.delete(id)
    // The oldest go first, so a page left open making them can't fill memory.
    for (const id of [...links.keys()].slice(0, Math.max(links.size - MAX + 1, 0))) links.delete(id)
    const token = randomBytes(24).toString('base64url')
    const open = new Set([...links.values()].map(link => link.code))
    let code: string
    do code = Array.from({length: CODE_LENGTH}, () => LETTERS[randomInt(LETTERS.length)]).join('')
    while (open.has(hash(code)))
    const expires = now + LINK_MINUTES * 60_000
    links.set(hash(token), {person, expires, code: hash(code)})
    return {token, code, expires_at: new Date(expires).toISOString()}
}

/** Whose a link is, using it up: nobody's once used, expired or never made. */
export function takeSignInLink(token: unknown, now = Date.now()): string | undefined {
    if (typeof token !== 'string' || !/^[\w-]{20,64}$/.test(token)) return
    const id = hash(token)
    const link = links.get(id)
    links.delete(id)
    return link && link.expires > now ? link.person : undefined
}

/** Whose a typed code is, using up its link: nobody's once used, expired or never made. Each wrong one counts, and
 * the {@link WRONG_CODES}th in a row ends every code still open. */
export function takeSignInCode(code: unknown, now = Date.now()): string | undefined {
    const typed = typeof code === 'string' ? normalize(code) : ''
    const id = typed.length === CODE_LENGTH ? hash(typed) : ''
    const found = id && [...links].find(([, link]) => link.code === id && link.expires > now)
    if (found) {
        links.delete(found[0])
        wrong = 0
        return found[1].person
    }
    if (++wrong >= WRONG_CODES) {
        for (const link of links.values()) delete link.code
        wrong = 0
    }
    return undefined
}

/** Ends every link not yet used (tests). */
export function clearSignInLinks() {
    links.clear()
    wrong = 0
}
