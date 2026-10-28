// How much room this orrery's data takes, for App settings → Database: a SQLite file with the `-wal` beside it, or the
// Postgres database, as it reports itself; and its backup folder's files. Any of it that can't be read (a file not
// there yet, no permission on a managed Postgres) is left out.
import {readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'
import type {DatabaseInfo} from '#shared/roadmap'
import type {Db} from './database'

export async function databaseSize(info: DatabaseInfo, db: Db): Promise<{size?: number, backup_size?: number}> {
    const size = info.kind === 'postgres' ? await postgresSize(db) : sqliteSize(info.where)
    const backup = info.backup && !info.backup_kind ? folderSize(info.backup) : undefined
    return {...size === undefined ? {} : {size}, ...backup === undefined ? {} : {backup_size: backup}}
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

/** The files in the folder and the folders in it, together; none for one that isn't there. */
function folderSize(dir: string): number | undefined {
    try {
        return readdirSync(dir, {withFileTypes: true}).reduce((total, entry) => {
            const path = join(dir, entry.name)
            return total + (entry.isDirectory() ? folderSize(path) ?? 0 : entry.isFile() ? fileSize(path) ?? 0 : 0)
        }, 0)
    } catch {
        return undefined
    }
}
