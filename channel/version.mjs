// The version of the code the channel and the launcher run, from the checkout they run from (web/package.json), which
// they tell orrery as they connect, so its Sessions page can mark one older than itself (ORR-434). Read again, it says
// whether the checkout has moved on since this process started.
import {readFileSync} from 'node:fs'

/** The version in the checkout now; none when it can't be read. */
export function versionOnDisk() {
    try {
        return JSON.parse(readFileSync(new URL('../web/package.json', import.meta.url), 'utf8')).version
    } catch {
        return undefined
    }
}

/** The version this process started on. */
export const VERSION = versionOnDisk() ?? '0.0.0'

/** What a launcher on `mine` does about Orrerys running `theirs` (ORR-434): `restart` once the checkout holds other code
 * (`disk`) and no session of its own is running, as only the service is started again; `tell` the owner to update the
 * checkout while it still holds the code it runs; else nothing, `wait` while it has sessions running. */
export function launcherMove({theirs, mine, disk, running, service}) {
    if (!service || theirs.every(v => v === mine)) return null
    if (!disk || disk === mine) return 'tell'
    return running ? 'wait' : 'restart'
}
