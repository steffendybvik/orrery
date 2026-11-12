// What the backups and App settings → Database ask of the database itself (ORR-1140): whether it's a new orrery's, a
// Postgres one's size, and the name this orrery runs under, kept for its backups to carry. With the Rust API there,
// it's asked (`GET /api/database`, `PUT /api/database/environment`), so this server reads none of it from the database
// (ORR-1093); with none (unit tests, a `nuxt dev` without its build), the database here answers, as before.
import type {DatabaseInfo} from '#shared/roadmap'
import {ORRERY} from '../store/schema'
import {writeToApi} from './api-router'
import {databaseSize} from './database-size'
import {useDatabase} from './db'
import {isFresh, noteEnvironment} from './restore'

type DatabaseState = {fresh: boolean, size?: number}

/** The API's word on the database; none with no API set up. */
async function fromApi(): Promise<DatabaseState | undefined> {
    return (await writeToApi('GET', '/api/database', undefined, ORRERY, {always: true}))?.reply as DatabaseState | undefined
}

/** Whether the database is a new orrery's: no projects, and no owner named yet. */
export async function databaseFresh(): Promise<boolean> {
    const state = await fromApi()
    return state ? state.fresh : isFresh(useDatabase())
}

/** How much room the data takes, and its backup folder, as `GET /api/machine` has it. */
export async function sizeOfDatabase(info: DatabaseInfo): Promise<{size?: number, backup_size?: number}> {
    // A SQLite file's size is read from the file, so only a Postgres one asks.
    if (info.kind !== 'postgres') return databaseSize(info, async () => undefined)
    const state = await fromApi()
    return databaseSize(info, state ? async () => state.size : useDatabase())
}

/** Keeps the name this orrery runs under in its settings, so its backups say which orrery they're a copy of. */
export async function keepEnvironment(environment: string): Promise<void> {
    if (await writeToApi('PUT', '/api/database/environment', {environment}, ORRERY, {always: true})) return
    await noteEnvironment(useDatabase(), environment)
}
