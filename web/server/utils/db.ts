// The database: one SQLite file (`NUXT_DATABASE`, `.data/orrery.db` by default), or Postgres. Node's own
// `node:sqlite` is synchronous, so writes from several sessions never interleave. Which one is the setting's alone:
// nothing in the app chooses or changes it.
import {mkdirSync} from 'node:fs'
import {onHost} from './host-paths'
import type {DatabaseInfo} from '#shared/roadmap'
import type {Db} from './database'
import {SqliteDb} from './database'
import {PostgresDb, isPostgres} from './postgres'
import {dirname, resolve} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MIGRATIONS} from './migrations/sqlite'
import {BASELINE, STEPS} from './migrations/postgres'
import {migrateWithApi} from './api-migrate'


let db: DatabaseSync | null = null

function useDb(path: string): DatabaseSync {
    if (db) return db
    db = openMigrated(path)
    return db
}

/** Opens a SQLite file with its schema up to date: migrated by the Rust API when there's one to ask (ORR-931), else here. */
export function openMigrated(path: string): DatabaseSync {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true})
    const ran = path === ':memory:' ? undefined : migrateWithApi(path, MIGRATIONS.length)
    const opened = openDb(path, MIGRATIONS.length)
    if (ran) migrated = ran
    return opened
}

/** Opens Postgres with its schema up to date: migrated by the Rust API when there's one to ask (ORR-931), else here. */
export function openPostgres(url: string): PostgresDb {
    const ran = migrateWithApi(url, BASELINE + STEPS.length)
    const opened = new PostgresDb(url)
    if (ran) opened.migrated = ran
    return opened
}

/** The database orrery runs on, as NUXT_DATABASE (ORRERY_DATABASE) names it: a Postgres URL, or a SQLite file, from
 * where it runs. Nothing in the app changes it. */
export function databaseSetting(): string {
    const setting = String(useRuntimeConfig().database)
    return isPostgres(setting) ? setting : resolve(setting)
}

/** Where the data is, to show the owner: the SQLite file's full path, or the Postgres database without its password. */
export function describeDatabase(): DatabaseInfo {
    const config = useRuntimeConfig()
    const setting = databaseSetting()
    const base = String(config.public?.repoDir ?? '')
    if (isPostgres(setting)) return {kind: 'postgres', where: hidePassword(setting)}
    // Under Docker, where it is on the computer too (`/data` means nothing there): ORR-399.
    return {kind: 'sqlite', where: setting, ...onHost(setting, '/data', String(config.dataHost ?? ''), base)}
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
    if (isPostgres(setting)) return database ??= openPostgres(setting)
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

/** The most the `-wal` file keeps once written through, in bytes. */
export const WAL_LIMIT = 4 * 1024 * 1024

/** Opens the file and brings its schema up to date (or only `upTo` steps, for tests). Backing it up first is whoever
 * runs orrery's to do. */
export function openDb(path: string, upTo = MIGRATIONS.length): DatabaseSync {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true})
    const opened = new DatabaseSync(path)
    try {
        // The wait first: in `nuxt dev` the server it replaces may still have the file. The
        // `-wal` beside it is cut back to WAL_LIMIT once written through, or it stays as big as the largest write it
        // ever took (a VACUUM: the whole file again, ORR-464).
        opened.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = ${WAL_LIMIT}`)
        migrated = migrate(opened, path, upTo) ?? migrated
    } catch (error) {
        opened.close()
        throw error
    }
    return opened
}

/** Brings `opened`'s schema up to `upTo` steps; says from and to, or null when it was there already. Refuses one
 * from a newer orrery (ORR-433): this code can't know what its steps changed. */
export function migrate(opened: DatabaseSync, path: string, upTo: number): {from: number, to: number} | null {
    const {user_version: version} = opened.prepare('PRAGMA user_version').get() as {user_version: number}
    if (version > MIGRATIONS.length) {
        throw new Error(`${path} was written by a newer orrery (schema step ${version}; this one knows up to ${MIGRATIONS.length}). `
            + 'Run that version again, or restore the copy of the database you took before it upgraded.')
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
