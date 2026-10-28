// A copy of the database in another folder (`NUXT_BACKUP_DIR`, e.g. in iCloud Drive), so it's saved
// off the machine. The live file stays local: a synced SQLite file gets corrupted, a snapshot doesn't.
// `orrery.db` there is always the latest; `orrery-YYYY-MM-DD.db` keeps one a day, for two weeks unless the owner
// chose another number (ORR-445), and only the latest few copies taken before an upgrade stay. A Postgres
// database is backed up the same way, as a SQLite snapshot of it, so a backup opens anywhere and a new SQLite
// Orrery starts from it.
import {copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync} from 'node:fs'
import {join} from 'node:path'
import type {DatabaseSync} from 'node:sqlite'
import type {Db} from './database'
import {SqliteDb} from './database'
import {copyDatabase} from './copy'
import {emptyDb} from './db'

const LATEST = 'orrery.db'
const PARTIAL = '.orrery.db.partial'
const DAILY = /^orrery-\d{4}-\d{2}-\d{2}\.db$/
/** The copies db.ts takes before an upgrade migrates the database (`orrery-pre-<version>.db`). */
const BEFORE_UPGRADE = /^orrery-pre-.+\.db$/
/** Daily copies kept unless the owner chose another number, and the most they can keep. */
export const KEEP_DAYS = 14
export const MAX_KEEP_DAYS = 365
/** Copies from before an upgrade kept, the newest. */
const KEEP_BEFORE_UPGRADE = 3

/** How often the owner has it back up: a few seconds after a change (a minute on Postgres), or at most once every
 * 15 minutes, hour or day, and then only when something changed. */
export const BACKUP_EVERY = ['change', '15m', 'hour', 'day'] as const
export type BackupEvery = typeof BACKUP_EVERY[number]
const INTERVAL: Record<Exclude<BackupEvery, 'change'>, number> = {'15m': 15 * 60_000, hour: 60 * 60_000, day: 24 * 60 * 60_000}

/** How long after a change to back up. `since` is the first change not backed up yet, `last` when the last backup
 * was made. After a change: a few seconds (`settle`), put off by more changes but never past ten waits from the first.
 * Every 15 minutes, hour or day: once that long has gone since the last backup, and never sooner than `settle`. */
export function backupDelay(every: BackupEvery, settle: number, now: number, since: number, last: number): number {
    if (every === 'change') return Math.max(0, Math.min(settle, since + 10 * settle - now))
    return Math.max(settle, last + INTERVAL[every] - now)
}

/** Writes a consistent copy of `db` to `dir`, then today's copy if there isn't one yet, keeping `days` of those. */
export function backup(db: DatabaseSync, dir: string, days = KEEP_DAYS) {
    const temporary = partial(dir)
    db.prepare('VACUUM INTO ?').run(temporary)
    keep(dir, days)
}

/** Writes a SQLite snapshot of the Postgres database `db` to `dir`, as `backup` does a SQLite one. */
export async function backupPostgres(db: Db, dir: string, days = KEEP_DAYS) {
    const snapshot = emptyDb(partial(dir))
    try {
        await copyDatabase(db, new SqliteDb(snapshot))
    } finally {
        snapshot.close()
    }
    keep(dir, days)
}

/** The backup being made, so another waits for it rather than writing over it. */
let making: Promise<void> = Promise.resolve()

/** Backs up the database Orrery runs on to `dir`, after any backup already being made: a SQLite one in line with
 * the writes (`VACUUM INTO` can't run in the middle of a transaction), a Postgres one as a snapshot. */
export function backUp(database: Db, dir: string, days = KEEP_DAYS): Promise<void> {
    making = making.catch(() => {}).then(() => database instanceof SqliteDb ? database.alone(raw => backup(raw, dir, days)) : backupPostgres(database, dir, days))
    return making
}

/** Where a backup is written before it's put in place, made ready (the folder there, nothing left from before). */
function partial(dir: string): string {
    mkdirSync(dir, {recursive: true})
    const temporary = join(dir, PARTIAL)
    for (const name of [temporary, `${temporary}-wal`, `${temporary}-shm`]) rmSync(name, {force: true})
    return temporary
}

/** Puts the written backup in place as the latest, keeps today's, and lets go of the daily ones past `days` and of
 * all but the newest few taken before an upgrade. */
function keep(dir: string, days: number) {
    renameSync(join(dir, PARTIAL), join(dir, LATEST))
    const today = join(dir, `orrery-${new Date().toISOString().slice(0, 10)}.db`)
    if (!existsSync(today)) copyFileSync(join(dir, LATEST), today)
    const names = readdirSync(dir)
    names.filter(name => DAILY.test(name)).sort().slice(0, -days).forEach(name => rmSync(join(dir, name)))
    names.filter(name => BEFORE_UPGRADE.test(name)).map(name => ({name, at: statSync(join(dir, name)).mtimeMs}))
        .sort((a, b) => b.at - a.at).slice(KEEP_BEFORE_UPGRADE).forEach(({name}) => rmSync(join(dir, name)))
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
