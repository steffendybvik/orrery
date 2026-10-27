// A copy of the database in another folder (`NUXT_BACKUP_DIR`, e.g. in iCloud Drive), so it's saved
// off the machine. The live file stays local: a synced SQLite file gets corrupted, a snapshot doesn't.
// `orrery.db` there is always the latest; `orrery-YYYY-MM-DD.db` keeps one a day for two weeks. A Postgres
// database is backed up the same way, as a SQLite snapshot of it, so a backup opens anywhere and a new SQLite
// Orrery starts from it.
import {copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync} from 'node:fs'
import {join} from 'node:path'
import type {DatabaseSync} from 'node:sqlite'
import type {Db} from './database'
import {SqliteDb} from './database'
import {copyDatabase} from './copy'
import {openDb} from './db'

const LATEST = 'orrery.db'
const PARTIAL = '.orrery.db.partial'
const DAILY = /^orrery-\d{4}-\d{2}-\d{2}\.db$/
const KEEP_DAYS = 14

/** Writes a consistent copy of `db` to `dir`, then today's copy if there isn't one yet. */
export function backup(db: DatabaseSync, dir: string) {
    const temporary = partial(dir)
    db.prepare('VACUUM INTO ?').run(temporary)
    keep(dir)
}

/** Writes a SQLite snapshot of the Postgres database `db` to `dir`, as `backup` does a SQLite one. */
export async function backupPostgres(db: Db, dir: string) {
    const snapshot = openDb(partial(dir))
    try {
        await copyDatabase(db, new SqliteDb(snapshot))
        // One file, like `VACUUM INTO`'s, with nothing left in a write-ahead log beside it.
        snapshot.exec('PRAGMA journal_mode = DELETE')
    } finally {
        snapshot.close()
    }
    keep(dir)
}

/** The backup being made, so another waits for it rather than writing over it. */
let making: Promise<void> = Promise.resolve()

/** Backs up the database Orrery runs on to `dir`, after any backup already being made: a SQLite one in line with
 * the writes (`VACUUM INTO` can't run in the middle of a transaction), a Postgres one as a snapshot. */
export function backUp(database: Db, dir: string): Promise<void> {
    making = making.catch(() => {}).then(() => database instanceof SqliteDb ? database.alone(raw => backup(raw, dir)) : backupPostgres(database, dir))
    return making
}

/** Where a backup is written before it's put in place, made ready (the folder there, nothing left from before). */
function partial(dir: string): string {
    mkdirSync(dir, {recursive: true})
    const temporary = join(dir, PARTIAL)
    for (const name of [temporary, `${temporary}-wal`, `${temporary}-shm`]) rmSync(name, {force: true})
    return temporary
}

/** Puts the written backup in place as the latest, keeps today's, and lets go of those past two weeks. */
function keep(dir: string) {
    renameSync(join(dir, PARTIAL), join(dir, LATEST))
    const today = join(dir, `orrery-${new Date().toISOString().slice(0, 10)}.db`)
    if (!existsSync(today)) copyFileSync(join(dir, LATEST), today)
    readdirSync(dir).filter(name => DAILY.test(name)).sort().slice(0, -KEEP_DAYS).forEach(name => rmSync(join(dir, name)))
}

/** When the latest backup in `dir` was made, if there is one. */
export function lastBackup(dir: string): string | undefined {
    try {
        return statSync(join(dir, LATEST)).mtime.toISOString()
    } catch {
        return undefined
    }
}

/** A database that isn't there yet (a new machine, a fresh volume) starts from the backup. */
export function restoreBackup(path: string, dir: string) {
    if (!dir || existsSync(path) || !existsSync(join(dir, LATEST))) return
    mkdirSync(join(path, '..'), {recursive: true})
    copyFileSync(join(dir, LATEST), path)
    console.info(`[orrery] restored the database from ${join(dir, LATEST)}`)
}
