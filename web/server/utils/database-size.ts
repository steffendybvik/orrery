// How much room this Orrery's data takes, for App settings → Database: a SQLite file with the `-wal` beside it, or the
// Postgres database, as it reports itself; and its backup folder's files. Any of it that can't be read (a file not
// there yet, no permission on a managed Postgres) is left out.
import {readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'
import type {DatabaseInfo} from '#shared/roadmap'
import type {Db} from './database'

export async function databaseSize(info: DatabaseInfo, db: Db): Promise<{size?: number, backup_size?: number}> {
    if (info.kind === 'postgres') {
        try {
            const row = await db.get<{size: string | number}>('SELECT pg_database_size(current_database()) AS size')
            const size = Number(row?.size)
            return Number.isFinite(size) ? {size} : {}
        } catch {
            return {}
        }
    }
    const size = fileSize(info.where)
    const backup = info.backup ? folderSize(info.backup) : undefined
    return {...size === undefined ? {} : {size: size + (fileSize(`${info.where}-wal`) ?? 0)}, ...backup === undefined ? {} : {backup_size: backup}}
}

function fileSize(path: string): number | undefined {
    try {
        return statSync(path).size
    } catch {
        return undefined
    }
}

/** The files in the folder and the folders in it, together; none for one that isn't there. */
export function folderSize(dir: string): number | undefined {
    try {
        return readdirSync(dir, {withFileTypes: true}).reduce((total, entry) => {
            const path = join(dir, entry.name)
            return total + (entry.isDirectory() ? folderSize(path) ?? 0 : entry.isFile() ? fileSize(path) ?? 0 : 0)
        }, 0)
    } catch {
        return undefined
    }
}
