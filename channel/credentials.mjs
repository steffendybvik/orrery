// The key this machine sends an orrery (ORR-664): `ORRERY_KEY`, else ~/.config/orrery/keys.json, keyed by server, for
// someone on several. Never the committed .mcp.json. Only an agent key: a person key signs in to the page, and in a session's
// environment it would make the session its person, so one here is refused before it's sent anywhere. With none, nothing
// is sent, which is all a one-person orrery on loopback wants.
import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

const originOf = url => {
    try {
        return new URL(url).origin
    } catch {
        return url
    }
}

export const keysFile = (env = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orrery', 'keys.json')

/** The key for the orrery at `url`, if this machine has one. Throws on a person key. */
export function keyFor(url, {env = process.env, file = keysFile(env)} = {}) {
    let key = env.ORRERY_KEY?.trim()
    if (!key) {
        try {
            const keys = JSON.parse(readFileSync(file, 'utf8'))
            key = Object.entries(keys).find(([server]) => originOf(server) === originOf(url))?.[1]
        } catch {
            return undefined
        }
    }
    if (typeof key === 'string' && key.startsWith('orrery_person_')) {
        throw new Error('ORRERY_KEY holds a person key, which is for signing in to the page: a session must not have it. Make an agent key on the page, and use that')
    }
    return key || undefined
}

/** What goes on every request to the orrery at `url`. */
export function authHeaders(url, options) {
    const key = keyFor(url, options)
    return key ? {Authorization: `Bearer ${key}`} : {}
}
