// The database: one SQLite file (`NUXT_DATABASE`, `.data/orrery.db` by default), or Postgres. Node's own
// `node:sqlite` is synchronous, so writes from several sessions never interleave. The owner can move it from App
// settings (server/utils/move.ts); where it went is kept beside the SQLite file, unless NUXT_DATABASE is Postgres.
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {lastBackup, lastBackupFailure, lastPostgresBackup, putInPlace} from './backup'
import {backupChoice, backupChoiceFile, backupDir, backupEvery, backupKeep, backupTarget, defaultBackupDir, inDocker} from './backup-choice'
import {onHost} from './host-paths'
import type {DatabaseInfo} from '#shared/roadmap'
import type {Db} from './database'
import {SqliteDb} from './database'
import {PostgresDb, isPostgres} from './postgres'
import {dirname, join, resolve} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MIGRATIONS} from './migrations/sqlite'


let db: DatabaseSync | null = null

function useDb(path: string): DatabaseSync {
    if (db) return db
    // A new database doesn't start from a backup by itself (ORR-448): its first page asks, see server/utils/restore.ts.
    db = openDb(path, MIGRATIONS.length, beforeUpgrade(path))
    return db
}

/** Where the copy of a SQLite file goes before an upgrade's steps, as it was: in the backup folder, or beside the file
 * when backups are off. */
export function beforeUpgrade(path: string): string {
    return join(backupDir() || dirname(path), `orrery-pre-${useRuntimeConfig().public?.version ?? 'upgrade'}.db`)
}

/** Where a move from App settings is kept: beside the SQLite file NUXT_DATABASE names (`orrery.db.moved.json`); none
 * when NUXT_DATABASE is Postgres, which stays where it's set. */
export function movedFile(): string | null {
    const setting = String(useRuntimeConfig().database)
    return isPostgres(setting) ? null : `${resolve(setting)}.moved.json`
}

/** The database orrery runs on: where the owner moved it to, else NUXT_DATABASE (a SQLite file, from where it runs). */
let chosen: string | null | undefined

export function databaseSetting(): string {
    const setting = String(useRuntimeConfig().database)
    if (chosen === undefined) {
        const file = movedFile()
        chosen = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as {database: string}).database : null
    }
    return chosen ?? (isPostgres(setting) ? setting : resolve(setting))
}

/** Saves where the database moved to, for orrery to open again as it starts; back to NUXT_DATABASE's own file forgets it. */
function saveDatabaseSetting(setting: string) {
    const file = movedFile()
    if (!file) throw new Error('NUXT_DATABASE names Postgres: change it there')
    if (setting === resolve(String(useRuntimeConfig().database))) {
        rmSync(file, {force: true})
        chosen = null
    } else {
        writeFileSync(file, `${JSON.stringify({database: setting, moved_at: new Date().toISOString()}, null, 2)}\n`, {mode: 0o600})
        // `mode` holds only for a file it makes; one already there keeps its own, and this one holds a password.
        chmodSync(file, 0o600)
        chosen = setting
    }
}

/** Where the data is, to show the owner: the SQLite file's full path, or the Postgres database without its password. */
export function describeDatabase(): DatabaseInfo {
    const config = useRuntimeConfig()
    const setting = databaseSetting()
    const target = backupTarget()
    const dir = target?.kind === 'folder' ? target.dir : ''
    const at = dir ? lastBackup(dir) : target?.kind === 'postgres' ? lastPostgresBackup(target.url) : undefined
    const failed = target ? lastBackupFailure(target) : undefined
    const base = String(config.public?.repoDir ?? '')
    // Under Docker, where each is on the computer too (`/data` and `/backup` mean nothing there): ORR-399.
    const backupOn = dir ? onHost(resolve(dir), '/backup', String(config.backupHost ?? ''), base) : {}
    const backup = dir ? {
        backup: resolve(dir), ...at ? {backed_up_at: at} : {},
        ...backupOn.host ? {backup_host: backupOn.host} : {}, ...backupOn.volume ? {backup_volume: backupOn.volume} : {},
    } : target?.kind === 'postgres' ? {backup: hidePassword(target.url), backup_kind: 'postgres' as const, ...at ? {backed_up_at: at} : {}} : {}
    const how = movedFile() ? {movable: true, ...chosen ? {moved: true} : {}} : {}
    const choice = backupChoice()
    const settable = backupChoiceFile() ? {backups_settable: inDocker() ? 'switch' as const : 'folder' as const} : {}
    const backups = {...settable, ...choice?.on === false ? {backups_off: true} : {}, ...choice?.folder ? {backup_folder: choice.folder} : {},
        ...choice?.postgres ? {backup_postgres: hidePassword(choice.postgres)} : {},
        ...defaultBackupDir() ? {backup_default: defaultBackupDir()} : {}, backup_every: backupEvery(), backup_keep: backupKeep(),
        ...target && failed ? {backup_failed: failed} : {},
        // In Docker, backups in the default folder (ORRERY_BACKUP unset) never leave this computer.
        ...target?.kind === 'folder' && inDocker() && !config.backupChosen ? {backup_local: true as const} : {}}
    if (isPostgres(setting)) return {kind: 'postgres', where: hidePassword(setting), ...how, ...backup, ...backups}
    return {kind: 'sqlite', where: setting, ...onHost(setting, '/data', String(config.dataHost ?? ''), base), ...how, ...backup, ...backups}
}

/** A Postgres URL as the owner sees it: `user@host:port/name`, no password. */
export function hidePassword(url: string): string {
    const parsed = new URL(url)
    return `${parsed.username ? `${decodeURIComponent(parsed.username)}@` : ''}${parsed.host}${parsed.pathname}`
}

/** The open database as the store awaits it: Postgres when the setting is a `postgres://` URL, else the
 * SQLite file. */
export function useDatabase(): Db {
    const setting = databaseSetting()
    if (isPostgres(setting)) return database ??= new PostgresDb(setting)
    const raw = useDb(setting)
    if (!(database instanceof SqliteDb) || database.raw !== raw) database = new SqliteDb(raw)
    return database
}

let database: SqliteDb | PostgresDb | null = null

/** Lets go of the database, e.g. as `nuxt dev` swaps in a reloaded server; the next use opens it again. */
export async function closeDb() {
    db?.close()
    db = null
    if (database instanceof PostgresDb) await database.close()
    database = null
}

/** Runs on `next` from now on (already open, its schema up to date), saved for the next start, with what else holds the
 * database pointed at it (`rebind`), and lets go of the one before once what it was doing is done. Saved first: a save
 * that fails (a full disk) changes nothing. Says which it was. */
export async function switchDatabase(setting: string, next: SqliteDb | PostgresDb, rebind: (db: SqliteDb | PostgresDb) => void): Promise<SqliteDb | PostgresDb | null> {
    const before = database
    const raw = db
    saveDatabaseSetting(setting)
    database = next
    db = next instanceof SqliteDb ? next.raw : null
    rebind(next)
    if (before instanceof PostgresDb) await before.close()
    else if (before instanceof SqliteDb) await before.alone(() => raw?.close())
    return before
}

/** The most the `-wal` file keeps once written through, in bytes. */
export const WAL_LIMIT = 4 * 1024 * 1024

/** Opens the file and brings its schema up to date (or only `upTo` steps, for tests), copying it first, when there are
 * steps to take, to `snapshot` (`orrery-pre-<version>.db`) with the step it's at added (`-step<n>.db`), unless there's
 * a copy there already. */
export function openDb(path: string, upTo = MIGRATIONS.length, snapshot?: string): DatabaseSync {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true})
    const opened = new DatabaseSync(path)
    try {
        // The wait first: in `nuxt dev` the server it replaces may still have the file (backing it up as it goes). The
        // `-wal` beside it is cut back to WAL_LIMIT once written through, or it stays as big as the largest write it
        // ever took (a VACUUM: the whole file again, ORR-464).
        opened.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = ${WAL_LIMIT}`)
        migrated = migrate(opened, path, upTo, snapshot) ?? migrated
    } catch (error) {
        opened.close()
        throw error
    }
    return opened
}

/** Brings `opened`'s schema up to `upTo` steps; says from and to, or null when it was there already. Refuses one
 * from a newer orrery (ORR-433): this code can't know what its steps changed. */
export function migrate(opened: DatabaseSync, path: string, upTo: number, snapshot?: string): {from: number, to: number} | null {
    const {user_version: version} = opened.prepare('PRAGMA user_version').get() as {user_version: number}
    if (version > MIGRATIONS.length) {
        throw new Error(`${path} was written by a newer orrery (schema step ${version}; this one knows up to ${MIGRATIONS.length}). `
            + 'Run that version again, or restore the copy taken before it upgraded (orrery-pre-<version>-step<n>.db, in the backup folder or beside the database).')
    }
    // A new file has nothing to keep. The copy is named by the schema step it was taken at as well as the version, so a
    // later step under the same version gets one of its own (ORR-457); one already there is from an earlier try at this
    // same upgrade, so it stays. It's written beside the name and checked before it takes it (ORR-448), so a copy cut
    // short never passes for one.
    if (snapshot) snapshot = snapshot.replace(/(\.db)?$/, `-step${version}.db`)
    if (snapshot && version > 0 && version < Math.min(upTo, MIGRATIONS.length) && !existsSync(snapshot)) {
        const temporary = `${snapshot}.partial`
        try {
            mkdirSync(dirname(snapshot), {recursive: true})
            rmSync(temporary, {force: true})
            opened.prepare('VACUUM INTO ?').run(temporary)
            putInPlace(temporary, snapshot)
        } catch (error) {
            try {
                rmSync(temporary, {force: true})
            } catch {
                // Nowhere to write means nothing was left there.
            }
            throw new Error(`orrery won't upgrade ${path} (schema step ${version} to ${Math.min(upTo, MIGRATIONS.length)}) without a copy of it as it is, `
                + `and couldn't make one at ${snapshot}: ${(error as Error).message}. Free some space or fix the folder, then start it again.`, {cause: error})
        }
    }
    // Foreign keys are off while tables are rebuilt (SQLite can't turn them off inside a transaction).
    opened.exec('PRAGMA foreign_keys = OFF')
    MIGRATIONS.slice(version, upTo).forEach((step, i) => {
        transaction(opened, () => {
            if (typeof step === 'string') opened.exec(step)
            else step(opened)
            opened.exec(`PRAGMA user_version = ${version + i + 1}`)
        })
    })
    if (opened.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`${path}: a migration left rows pointing at nothing`)
    opened.exec('PRAGMA foreign_keys = ON')
    return version < Math.min(upTo, MIGRATIONS.length) ? {from: version, to: Math.min(upTo, MIGRATIONS.length)} : null
}

/** An empty database with the schema up to date, laid down once, in memory. */
let schema: DatabaseSync | null = null

/** A new file at `path` with the schema up to date and nothing in it, copied from `schema`: a Postgres backup is
 * written into one as often as once a minute, and every migration again (table rebuilds included) each time is the
 * slow way there. No migration the event log hears of. */
export function emptyDb(path: string): DatabaseSync {
    if (!schema) {
        schema = new DatabaseSync(':memory:')
        migrate(schema, ':memory:', MIGRATIONS.length)
    }
    mkdirSync(dirname(path), {recursive: true})
    schema.prepare('VACUUM INTO ?').run(path)
    const opened = new DatabaseSync(path)
    opened.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON')
    return opened
}

/** The steps the last file opened was brought up by, for the event log; null when it was up to date. */
let migrated: {from: number, to: number} | null = null

/** The migration the open database had as it opened (SQLite's steps, or Postgres's), once; then null. */
export function takeMigration(): {from: number, to: number} | null {
    const database = useDatabase()
    const ran = database instanceof PostgresDb ? database.migrated : migrated
    if (database instanceof PostgresDb) database.migrated = null
    else migrated = null
    return ran
}

/** Runs `work` in one transaction: all of it lands, or none of it. */
export function transaction<T>(database: DatabaseSync, work: () => T): T {
    database.exec('BEGIN IMMEDIATE')
    try {
        const result = work()
        database.exec('COMMIT')
        return result
    } catch (error) {
        database.exec('ROLLBACK')
        throw error
    }
}
