// How much room this orrery's data takes, for App settings → Database: a SQLite file with the `-wal` beside it, or the
// Postgres database, as it reports itself. Any of it that can't be read (a file not there yet, no permission on a
// managed Postgres) is left out.
import {statSync} from 'node:fs'
import type {DatabaseInfo} from '#shared/roadmap'
import type {Db} from './database'

/** `db` is the database to ask a Postgres one's size, or what asks it elsewhere (the Rust API's, ORR-1140). */
export async function databaseSize(info: DatabaseInfo, db: Db | (() => Promise<number | undefined>)): Promise<{size?: number}> {
    const size = info.kind === 'postgres' ? await (typeof db === 'function' ? db() : postgresSize(db)) : sqliteSize(info.where)
    return size === undefined ? {} : {size}
}

async function postgresSize(db: Db): Promise<number | undefined> {
    try {
        const row = await db.get<{size: string | number}>('SELECT pg_database_size(current_database()) AS size')
        const size = Number(row?.size)
        return Number.isFinite(size) ? size : undefined
    } catch {
        return undefined
    }
}

function sqliteSize(where: string): number | undefined {
    const size = fileSize(where)
    return size === undefined ? undefined : size + (fileSize(`${where}-wal`) ?? 0)
}

function fileSize(path: string): number | undefined {
    try {
        return statSync(path).size
    } catch {
        return undefined
    }
}
