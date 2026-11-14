// What App settings → Database and the start ask of the database itself (ORR-1140): whether it's a new orrery's, and
// a Postgres one's size. With the Rust API there, it's asked (`GET /api/database`), so this server reads none of it
// from the database (ORR-1093); with none (unit tests, a `nuxt dev` without its build), the database here answers, as
// before.
import type {DatabaseInfo} from '#shared/roadmap'
import {ORRERY} from '../store/schema'
import {writeToApi} from './api-router'
import type {Db} from './database'
import {databaseSize} from './database-size'
import {useDatabase} from './db'

type DatabaseState = {fresh: boolean, size?: number}

/** The API's word on the database; none with no API set up. */
async function fromApi(): Promise<DatabaseState | undefined> {
    return (await writeToApi('GET', '/api/database', undefined, ORRERY, {always: true}))?.reply as DatabaseState | undefined
}

/** Whether `db` is a new orrery's: no projects, and no owner named yet. */
export async function isFresh(db: Db): Promise<boolean> {
    const projects = await db.get<{n: number}>('SELECT count(*) AS n FROM projects')
    if (Number(projects?.n ?? 0)) return false
    return !await db.get('SELECT 1 AS found FROM people WHERE role = \'owner\'')
}

/** Whether the database is a new orrery's: no projects, and no owner named yet. */
export async function databaseFresh(): Promise<boolean> {
    const state = await fromApi()
    return state ? state.fresh : isFresh(useDatabase())
}

/** How much room the data takes, as `GET /api/machine` has it. */
export async function sizeOfDatabase(info: DatabaseInfo): Promise<{size?: number}> {
    // A SQLite file's size is read from the file, so only a Postgres one asks.
    if (info.kind !== 'postgres') return databaseSize(info, async () => undefined)
    const state = await fromApi()
    return databaseSize(info, state ? async () => state.size : useDatabase())
}
