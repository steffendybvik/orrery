// What App settings → Database and the start ask of the database itself (ORR-1140): whether it's a new orrery's, and
// a Postgres one's size. The Rust API is asked (`GET /api/database`), so this server reads none of it from the
// database (ORR-1093); with no API set up, the question fails as one that isn't running does (ORR-1135).
import type {DatabaseInfo} from '#shared/roadmap'
import {readFromApiOnly} from './api-router'
import {databaseSize} from './database-size'

type DatabaseState = {fresh: boolean, size?: number}

/** The API's word on the database. */
const fromApi = () => readFromApiOnly<DatabaseState>('/api/database')

/** Whether the database is a new orrery's: no projects, and no owner named yet. */
export async function databaseFresh(): Promise<boolean> {
    return (await fromApi()).fresh
}

/** How much room the data takes, as `GET /api/machine` has it. */
export async function sizeOfDatabase(info: DatabaseInfo): Promise<{size?: number}> {
    // A SQLite file's size is read from the file, so only a Postgres one asks.
    if (info.kind !== 'postgres') return databaseSize(info, async () => undefined)
    const state = await fromApi()
    return databaseSize(info, async () => state.size)
}
