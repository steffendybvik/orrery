// A copy of the database in another folder (`NUXT_BACKUP_DIR`, e.g. in iCloud Drive), so it's saved
// off the machine. The live file stays local: a synced SQLite file gets corrupted, a snapshot doesn't.
// `orrery.db` there is always the latest; `orrery-YYYY-MM-DD.db` keeps one a day for two weeks. A Postgres
// database is backed up the same way, as a SQLite snapshot of it, so a backup opens anywhere and a new SQLite
// Orrery starts from it. Or, either way, into a Postgres database of its own (ORR-427): the latest only, copied as a
// move copies, and marked as this Orrery's backup (`backup_of` in its settings), so a backup only ever writes over
// its own last one, never another Orrery's or the live database.
import {copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync} from 'node:fs'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'
import type {DatabaseSync} from 'node:sqlite'
import type {Db} from './database'
import {SqliteDb, one} from './database'
import {copyDatabase} from './copy'
import {emptyDb, hidePassword} from './db'
import {PostgresDb} from './postgres'

/** Where backups go: a folder, or a Postgres database. */
export type BackupTarget = {kind: 'folder', dir: string} | {kind: 'postgres', url: string}

/** Where a target is, as the owner sees it: a Postgres one without its password. */
export const targetLabel = (target: BackupTarget) => target.kind === 'folder' ? target.dir : hidePassword(target.url)

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
    const snapshot = emptyDb(partial(dir))
    try {
        await copyDatabase(db, new SqliteDb(snapshot))
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

/** Backs up to the target, a folder or a Postgres database, after any backup already being made. */
export function backUpTo(database: Db, target: BackupTarget): Promise<void> {
    if (target.kind === 'folder') return backUp(database, target.dir)
    making = making.catch(() => {}).then(() => backupInto(database, target.url))
    return making
}

/** The Postgres database backed up to, held open between backups (one a minute at most), and when it last worked. */
let into: {url: string, db: PostgresDb, at?: string} | null = null

/** When the latest backup into the Postgres database at `url` was made, since Orrery started. */
export const lastPostgresBackup = (url: string) => into?.url === url ? into.at : undefined

/** Lets go of the Postgres database backed up to, as Orrery stops or the backups go elsewhere. */
export async function closeBackupDb() {
    const held = into
    into = null
    await held?.db.close()
}

/** Copies `source` into the Postgres database at `url`, in place of the backup there: only into one that's empty or
 * already this Orrery's backup, and never into the database it runs on. */
async function backupInto(source: Db, url: string) {
    if (into?.url !== url) {
        await closeBackupDb()
        into = {url, db: new PostgresDb(url)}
    }
    const target = into.db
    // Its id, made now if it hasn't been asked for yet, as the store makes it.
    await source.run('INSERT INTO settings (key, value) VALUES (\'id\', ?) ON CONFLICT (key) DO NOTHING', JSON.stringify(`orr_${randomBytes(3).toString('hex')}`))
    const id = JSON.parse((await one<{value: string}>(source, 'SELECT value FROM settings WHERE key = \'id\'')).value) as string
    // The database it runs on is never a backup, even one it was started from, so it can't pass for its own backup
    // under another way of writing its URL.
    await source.run('DELETE FROM settings WHERE key = \'backup_of\'')
    if (source instanceof PostgresDb && await samePlace(source, target)) throw new Error(`${hidePassword(url)} is the database Orrery runs on: back up somewhere else`)
    const {n} = await one<{n: number}>(target, 'SELECT count(*) AS n FROM projects')
    const mark = await target.get<{value: string}>('SELECT value FROM settings WHERE key = \'backup_of\'')
    if (Number(n) && (!mark || JSON.parse(mark.value) !== id)) throw new Error(`${hidePassword(url)} holds an Orrery that isn't this one's backup: back up to an empty database`)
    await copyDatabase(source, target, {replace: true, mark: id})
    into.at = new Date().toISOString()
}

/** Whether two Postgres connections reach the same database and schema, however their URLs are written. */
async function samePlace(a: PostgresDb, b: PostgresDb): Promise<boolean> {
    const where = 'SELECT coalesce(inet_server_addr()::text, \'local\') || \':\' || coalesce(inet_server_port(), 0) || \'/\' || current_database() || \'.\' || current_schema() AS at'
    const [x, y] = await Promise.all([a.get<{at: string}>(where), b.get<{at: string}>(where)])
    return x?.at === y?.at
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
