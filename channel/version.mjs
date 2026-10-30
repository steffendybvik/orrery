// The version of the code the channel and the launcher run, from the checkout they run from (web/package.json), which
// they tell orrery as they connect, so its Sessions page can mark one older than itself (ORR-434). Read again, it says
// whether the checkout has moved on since this process started: by its code too, as that changes within a version
// (ORR-470).
import {createHash} from 'node:crypto'
import {readdirSync, readFileSync} from 'node:fs'
import {newer, servable} from './bootstrap.mjs'

/** Its version when it's the bundle the orrery serves (ORR-435), which has no checkout around it. */
const BUNDLED = typeof __ORRERY_VERSION__ === 'string' ? __ORRERY_VERSION__ : undefined
/** The bootstrap that ran this bundle, to name where a command runs it; none from a checkout. */
export const BOOTSTRAP = BUNDLED ? process.env.ORRERY_BOOTSTRAP : undefined

/** The version in the checkout now; none when it can't be read. */
export function versionOnDisk() {
    if (BUNDLED) return BUNDLED
    try {
        return JSON.parse(readFileSync(new URL('../web/package.json', import.meta.url), 'utf8')).version
    } catch {
        return undefined
    }
}

/** The code in the checkout now, as one hash of its version and every channel/*.mjs; none when it can't be read. */
export function codeOnDisk() {
    if (BUNDLED) return process.env.ORRERY_CODE
    try {
        const folder = new URL('./', import.meta.url)
        const hash = createHash('sha256').update(versionOnDisk() ?? '')
        for (const name of readdirSync(folder).filter(name => name.endsWith('.mjs')).sort()) {
            hash.update(`\0${name}\0`).update(readFileSync(new URL(name, folder)))
        }
        return hash.digest('hex').slice(0, 16)
    } catch {
        return undefined
    }
}

/** The version this process started on. */
export const VERSION = versionOnDisk() ?? '0.0.0'

/** The code this process started on. */
export const CODE = codeOnDisk()

/** What a launcher on version `mine` and code `code` does (ORR-434, ORR-470, ORR-686): `restart` once the checkout holds
 * other code (`now`), as only the service is started again, whether or not the version moved with it; `tell` the owner
 * to update the checkout while an orrery it serves (`theirs`) runs another version and the checkout still holds the code
 * it runs; else nothing, `wait` while it's `busy`: midway through something a restart would cut off. */
export function launcherMove({theirs, mine, code, now, busy, service}) {
    if (!service) return null
    if (!now || !code || now === code) return theirs.some(v => v !== mine) ? 'tell' : null
    return busy ? 'wait' : 'restart'
}

/** Whether a launcher the bootstrap ran gets other code by restarting, for what the orrery at `url` serves (`served`, its
 * manifest): a newer version, as the bootstrap takes the newest on the list; or other code from the orrery this copy
 * came from (`from`), even an older version. Other code at another orrery of the same version stays where it is, or two
 * such would restart it for ever. So does an orrery the bootstrap wouldn't fetch from. */
export function servedOtherCode({served, url, from, mine, code}) {
    if (!servable(url) || !served?.code || served.code === code) return false
    return newer(served.version, mine) || url === from
}
