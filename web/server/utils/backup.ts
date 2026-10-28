// A copy of the database in another folder (`NUXT_BACKUP_DIR`, e.g. in iCloud Drive), so it's saved
// off the machine. The live file stays local: a synced SQLite file gets corrupted, a snapshot doesn't.
// `orrery.db` there is always the latest; `orrery-YYYY-MM-DD.db` keeps one a day, for two weeks unless the owner
// chose another number (ORR-445), and only the latest few copies taken before an upgrade stay. A Postgres
// database is backed up the same way, as a SQLite snapshot of it, so a backup opens anywhere and a new SQLite
// orrery starts from it. Or, either way, into a Postgres database of its own (ORR-427): the latest only, copied as a
// move copies, and marked as this orrery's backup (`backup_of` in its settings), so a backup only ever writes over
// its own last one, never another orrery's or the live database. Each snapshot is written beside the one it replaces
// and passes SQLite's `quick_check` before it takes its place (ORR-448): one that fails is let go, and the one before
// stays.
import {existsSync, mkdirSync, renameSync, rmSync, statSync} from 'node:fs'
import {copyFile, readdir, rename, rm, stat} from 'node:fs/promises'
import {Worker} from 'node:worker_threads'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import type {Db} from './database'
import {SqliteDb, one} from './database'
import {copyDatabase} from './copy'
import {postgresHolds} from './move'
import {emptyDb, hidePassword} from './db'
import {PostgresDb} from './postgres'

/** Where backups go: a folder, or a Postgres database. */
export type BackupTarget = {kind: 'folder', dir: string} | {kind: 'postgres', url: string}

/** Where a target is, as the owner sees it: a Postgres one without its password. */
export const targetLabel = (target: BackupTarget) => target.kind === 'folder' ? target.dir : hidePassword(target.url)

const LATEST = 'orrery.db'
const PARTIAL = '.orrery.db.partial'
const DAILY = /^orrery-\d{4}-\d{2}-\d{2}\.db$/
/** The copies db.ts takes before an upgrade migrates the database (`orrery-pre-<version>-step<n>.db`). */
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

/** Writes a consistent copy of `db` beside the latest in `dir`, for `keep` to check and put in place. */
const snapshot = (db: DatabaseSync, dir: string) => db.prepare('VACUUM INTO ?').run(partial(dir))

/** Writes a SQLite snapshot of the Postgres database `db` to `dir`, as `backup` does a SQLite one. */
export async function backupPostgres(db: Db, dir: string, days = KEEP_DAYS) {
    const snapshot = emptyDb(partial(dir))
    try {
        await copyDatabase(db, new SqliteDb(snapshot))
    } finally {
        snapshot.close()
    }
    await keep(dir, days)
}

/** The backup being made, so another waits for it rather than writing over it. */
let making: Promise<void> = Promise.resolve()

/** Backs up the database orrery runs on to `dir`, after any backup already being made: a SQLite one in line with
 * the writes (`VACUUM INTO` can't run in the middle of a transaction), a Postgres one as a snapshot. Only the copy
 * holds up the writes: checking it, the daily copy and pruning come after, off the writes' way, so a slow backup folder
 * doesn't (ORR-483). */
export function backUp(database: Db, dir: string, days = KEEP_DAYS): Promise<void> {
    making = making.catch(() => {}).then(() => database instanceof SqliteDb
        ? database.alone(raw => snapshot(raw, dir)).then(() => keep(dir, days))
        : backupPostgres(database, dir, days))
    return making
}

/** The last backup that failed, since orrery started, until one to the same place works (ORR-448). */
let failure: {target: string, at: string, message: string} | null = null

/** Why the latest backup to `target` failed, and when; none when it worked, or hasn't been tried. */
export const lastBackupFailure = (target: BackupTarget) => failure?.target === targetLabel(target) ? {at: failure.at, message: failure.message} : undefined

/** Backs up to the target, a folder (keeping `days` daily copies) or a Postgres database (the latest only), after any
 * backup already being made. */
export function backUpTo(database: Db, target: BackupTarget, days = KEEP_DAYS): Promise<void> {
    const made = target.kind === 'folder' ? backUp(database, target.dir, days)
        : making = making.catch(() => {}).then(() => backupInto(database, target.url))
    return made.then(() => {
        if (failure?.target === targetLabel(target)) failure = null
    }, (error: Error) => {
        failure = {target: targetLabel(target), at: new Date().toISOString(), message: error.message}
        throw error
    })
}

/** The Postgres database backed up to, held open between backups (one a minute at most), the database backed up into
 * it and that one's id, and when it last worked. */
let into: {url: string, db: PostgresDb, source: Db, id: string, at?: string} | null = null

/** When the latest backup into the Postgres database at `url` was made, since orrery started. */
export const lastPostgresBackup = (url: string) => into?.url === url ? into.at : undefined

/** Lets go of the Postgres database backed up to, as orrery stops or the backups go elsewhere. */
export async function closeBackupDb() {
    const held = into
    into = null
    await held?.db.close()
}

/** Copies `source` into the Postgres database at `url`, in place of the backup there: only into one that's empty or
 * already this orrery's backup, and never into the database it runs on. One holding something else's tables is
 * refused before it's opened (ORR-454): opening a database lays orrery's tables down in it. */
async function backupInto(source: Db, url: string) {
    // What it writes to the database it runs on, it writes once a target and source are paired, not on every backup,
    // where it would land between the store's own transactions (ORR-457).
    if (into?.url !== url || into.source !== source) {
        await closeBackupDb()
        if (await postgresHolds(url) === 'other') throw new Error(`${hidePassword(url)} has tables of something else's: back up to an empty database, or this orrery's backup`)
        const db = new PostgresDb(url)
        try {
            into = {url, db, source, id: await readyToBackUp(source, db, url)}
        } catch (error) {
            await db.close()
            throw error
        }
    }
    const {db: target, id} = into
    const {n} = await one<{n: number}>(target, 'SELECT count(*) AS n FROM projects')
    const mark = await target.get<{value: string}>('SELECT value FROM settings WHERE key = \'backup_of\'')
    if (Number(n) && (!mark || JSON.parse(mark.value) !== id)) throw new Error(`${hidePassword(url)} holds an orrery that isn't this one's backup: back up to an empty database`)
    await copyDatabase(source, target, {replace: true, mark: id})
    into.at = new Date().toISOString()
}

/** Gets `source` ready to be backed up into `target`; says its id. It's given one if it hasn't been asked for yet, as
 * the store makes it. The database it runs on is never a backup, even one it was started from, so it can't pass for
 * its own backup under another way of writing its URL. */
async function readyToBackUp(source: Db, target: PostgresDb, url: string): Promise<string> {
    await source.run('INSERT INTO settings (key, value) VALUES (\'id\', ?) ON CONFLICT (key) DO NOTHING', JSON.stringify(`orr_${randomBytes(3).toString('hex')}`))
    const id = JSON.parse((await one<{value: string}>(source, 'SELECT value FROM settings WHERE key = \'id\'')).value) as string
    await source.run('DELETE FROM settings WHERE key = \'backup_of\'')
    if (source instanceof PostgresDb && await samePlace(source, target)) throw new Error(`${hidePassword(url)} is the database orrery runs on: back up somewhere else`)
    return id
}

/** Whether two Postgres connections reach the same database and schema, however their URLs are written. */
async function samePlace(a: PostgresDb, b: PostgresDb): Promise<boolean> {
    const where = 'SELECT coalesce(inet_server_addr()::text, \'local\') || \':\' || coalesce(inet_server_port(), 0) || \'/\' || current_database() || \'.\' || current_schema() AS at'
    const [x, y] = await Promise.all([a.get<{at: string}>(where), b.get<{at: string}>(where)])
    return x?.at === y?.at
}

/** Lets go of a SQLite file and what SQLite may have left beside it. */
const remove = (path: string) => [path, `${path}-wal`, `${path}-shm`].forEach(name => rmSync(name, {force: true}))

/** Where a backup is written before it's put in place, made ready (the folder there, nothing left from before). */
function partial(dir: string): string {
    mkdirSync(dir, {recursive: true})
    const temporary = join(dir, PARTIAL)
    remove(temporary)
    return temporary
}

/** Throws unless the SQLite file at `path` passes `quick_check` (`full`: the slower `integrity_check`, for a restore). */
export function checkSnapshot(path: string, full = false) {
    let opened: DatabaseSync | undefined
    let found: string[]
    try {
        opened = new DatabaseSync(path, {readOnly: true})
        found = (opened.prepare(`PRAGMA ${full ? 'integrity_check' : 'quick_check'}`).all() as Record<string, string>[]).map(row => String(Object.values(row)[0]))
    } catch (error) {
        found = [(error as Error).message]
    } finally {
        opened?.close()
    }
    unlessOk(found)
}

/** Throws unless what SQLite's check found is `ok` alone. */
function unlessOk(found: string[]) {
    if (found.length !== 1 || found[0] !== 'ok') throw new Error(`the copy is damaged (${found.slice(0, 3).join('; ')})`)
}

/** Reads each SQLite file in a worker thread, so the writes go on meanwhile: what `quick_check` finds (`check`), and the
 * id of the orrery it is, if it can be read. */
function readAside(files: {path: string, check?: boolean}[]): Promise<{found?: string[], id?: string}[]> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const {parentPort, workerData} = require('node:worker_threads')
            const {DatabaseSync} = require('node:sqlite')
            parentPort.postMessage(workerData.map(({path, check}) => {
                let db
                try {
                    db = new DatabaseSync(path, {readOnly: true})
                    const found = check ? db.prepare('PRAGMA quick_check').all().map(row => String(Object.values(row)[0])) : undefined
                    let id
                    try {
                        const row = db.prepare("SELECT value FROM settings WHERE key = 'id'").get()
                        id = row ? JSON.parse(row.value) : undefined
                    } catch {}
                    return {found, id}
                } catch (error) {
                    return {found: check ? [error.message] : undefined}
                } finally {
                    db?.close()
                }
            }))`, {eval: true, workerData: files})
        worker.once('message', resolve)
        worker.once('error', reject)
    })
}

/** Puts `from`, a snapshot just written, at `to` once it passes its check; one that doesn't is let go, and what was at
 * `to` stays. */
export function putInPlace(from: string, to: string) {
    try {
        checkSnapshot(from)
    } catch (error) {
        remove(from)
        throw new Error(`${(error as Error).message}: kept the one before`, {cause: error})
    }
    renameSync(from, to)
}

/** Puts the written backup in place as the latest, keeps today's, and lets go of the daily ones past `days` and of
 * all but the newest few taken before an upgrade. A latest that's another orrery's (a new one started fresh over a
 * folder with backups, or two sharing one) is set aside as `orrery-pre-other-<time>.db` rather than written over. */
async function keep(dir: string, days: number) {
    const latest = join(dir, LATEST)
    const written = join(dir, PARTIAL)
    const [now = {}, was] = await readAside([{path: written, check: true}, ...existsSync(latest) ? [{path: latest}] : []])
    try {
        unlessOk(now.found ?? [])
    } catch (error) {
        remove(written)
        throw new Error(`${(error as Error).message}: kept the one before`, {cause: error})
    }
    if (was?.id && now.id && was.id !== now.id) await rename(latest, join(dir, `orrery-pre-other-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.db`))
    await rename(written, latest)
    const today = join(dir, `orrery-${new Date().toISOString().slice(0, 10)}.db`)
    // Copied beside it and renamed, so a copy cut short is never taken for today's.
    if (!existsSync(today)) {
        await copyFile(latest, `${today}.partial`)
        await rename(`${today}.partial`, today)
    }
    const names = await readdir(dir)
    await Promise.all(names.filter(name => DAILY.test(name)).sort().slice(0, -days).map(name => rm(join(dir, name))))
    const upgrades = await Promise.all(names.filter(name => BEFORE_UPGRADE.test(name)).map(async name => ({name, at: (await stat(join(dir, name))).mtimeMs})))
    await Promise.all(upgrades.sort((a, b) => b.at - a.at).slice(KEEP_BEFORE_UPGRADE).map(({name}) => rm(join(dir, name))))
}

/** When the latest backup in `dir` was made, if there is one. */
export function lastBackup(dir: string): string | undefined {
    try {
        return statSync(join(dir, LATEST)).mtime.toISOString()
    } catch {
        return undefined
    }
}
