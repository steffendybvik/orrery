// Where a Docker orrery's data may have gone (ORR-1180). A new project name or folder gives Docker a new, empty volume,
// so an orrery that had data can start empty. Nothing at the start tells that from a brand-new install, which should
// log nothing, so the sign is a credential this database doesn't know: a key or a login cookie from when it had data.
// Said once a run, in the event log, and only on an empty database in Docker.
import {databaseFresh} from './database-state'
import {inDocker} from './host-paths'

export const LOST_DATA = 'This orrery\'s database is empty, but a key or login from before came to it. If it had data, it may be in another Docker volume (a folder or project with another name gives another one): see `docker volume ls`'

let said = false

/** Notes `LOST_DATA` the first time an unknown credential comes to an empty Docker orrery. */
export async function noteUnknownCredential(): Promise<void> {
    if (said || !inDocker()) return
    said = true
    if (!await databaseFresh().catch(() => false)) return
    console.warn(`[orrery] ${LOST_DATA}`)
    useEventLog().note({level: 'warn', kind: 'database.empty', message: LOST_DATA})
}

/** For tests: says it again. */
export function forgetLostData(): void {
    said = false
}
