// Connecting a machine to an orrery with login on, with no key to copy (ORR-1192). Two ways in, both ending with the
// launcher holding an agent key that reaches every workspace its person is in, which it writes to keys.json itself:
//
// - A **code** on the install line: the signed-in page puts a one-time code in the line it shows (`ORRERY_CODE`), and the
//   launcher swaps it for the key. Good once, for `CODE_MINUTES`.
// - A **request**, when the line is run without one: the launcher asks for one and opens the browser on the orrery's
//   Connect page, which shows the machine's name and a few words the terminal shows too, so a link sent by someone else
//   can't be passed off as yours. Whoever's signed in presses Connect, and the launcher, asking with the request's
//   secret, gets the key. Good for `REQUEST_MINUTES`.
//
// Both are kept only in memory, hashed, as the phone's sign-in links are, so a restart ends them all.
import {createHash, randomBytes, randomInt} from 'node:crypto'

export const CODE_MINUTES = 15
export const REQUEST_MINUTES = 10
const MAX = 50
/** No 0/O, 1/I/L: easy to read off a screen. */
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const shaped = (text: unknown, min = 20): text is string => typeof text === 'string' && text.length >= min && text.length <= 80 && /^[\w-]+$/.test(text)

const codes = new Map<string, {person: string, expires: number}>()
type Request = {name: string, words: string, secret: string, expires: number, person?: string}
const requests = new Map<string, Request>()

function prune<T extends {expires: number}>(kept: Map<string, T>, now: number) {
    for (const [id, item] of kept) if (item.expires <= now) kept.delete(id)
    // The oldest go first, so nothing left asking can fill memory.
    for (const id of [...kept.keys()].slice(0, Math.max(kept.size - MAX + 1, 0))) kept.delete(id)
}

/** A machine's name as it's shown and kept on its key: what it says, trimmed, or "A computer". */
export function machineName(name: unknown): string {
    const said = typeof name === 'string' ? [...name].filter(c => c.charCodeAt(0) >= 32).join('').trim().slice(0, 60) : ''
    return said || 'A computer'
}

/** A one-time code for the install line `person` copies, and when it stops working. */
export function makeConnectCode(person: string, now = Date.now()): {code: string, expires_at: string} {
    prune(codes, now)
    const code = `oc_${randomBytes(18).toString('base64url')}`
    const expires = now + CODE_MINUTES * 60_000
    codes.set(hash(code), {person, expires})
    return {code, expires_at: new Date(expires).toISOString()}
}

/** Whose a code is, using it up: nobody's once used, expired or never made. */
export function takeConnectCode(code: unknown, now = Date.now()): string | undefined {
    if (!shaped(code)) return undefined
    const id = hash(code)
    const found = codes.get(id)
    codes.delete(id)
    return found && found.expires > now ? found.person : undefined
}

/** A request for `name` to connect: its id (for the page's address), the secret the launcher asks with, and the words
 *  both show. */
export function makeConnectRequest(name: string, now = Date.now()): {request: string, secret: string, words: string, expires_at: string} {
    prune(requests, now)
    const request = randomBytes(12).toString('base64url')
    const secret = randomBytes(24).toString('base64url')
    const pick = () => Array.from({length: 4}, () => LETTERS[randomInt(LETTERS.length)]).join('')
    const words = `${pick()}-${pick()}`
    const expires = now + REQUEST_MINUTES * 60_000
    requests.set(request, {name, words, secret: hash(secret), expires})
    return {request, secret, words, expires_at: new Date(expires).toISOString()}
}

/** A request still open, as the Connect page shows it. */
export function connectRequest(request: unknown, now = Date.now()): {name: string, words: string, expires_at: string, approved: boolean} | undefined {
    const found = typeof request === 'string' ? requests.get(request) : undefined
    if (!found || found.expires <= now) return undefined
    return {name: found.name, words: found.words, expires_at: new Date(found.expires).toISOString(), approved: Boolean(found.person)}
}

/** `person` says yes to a request; false when it's gone. Once approved, it stays theirs. */
export function approveConnectRequest(request: unknown, person: string, now = Date.now()): boolean {
    const found = typeof request === 'string' ? requests.get(request) : undefined
    if (!found || found.expires <= now) return false
    found.person ??= person
    return found.person === person
}

/** What the launcher hears asking with its secret: `waiting` until it's approved, then the person, once (the request
 *  goes); `gone` when it's expired, unknown or the secret is wrong. */
export function claimConnectRequest(request: unknown, secret: unknown, now = Date.now()): {waiting: true} | {person: string, name: string} | {gone: true} {
    const found = typeof request === 'string' ? requests.get(request) : undefined
    if (!found || !shaped(secret) || found.secret !== hash(secret)) return {gone: true}
    if (found.expires <= now) {
        requests.delete(request as string)
        return {gone: true}
    }
    if (!found.person) return {waiting: true}
    requests.delete(request as string)
    return {person: found.person, name: found.name}
}

/** Forgets every code and request, for the tests. */
export function forgetConnects() {
    codes.clear()
    requests.clear()
}
