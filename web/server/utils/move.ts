// Moving to another database from App settings: a SQLite file on this machine, or Postgres. It's checked first
// (`POST /api/database/check`): an empty one has everything copied into it (the same copy as `pnpm orrery:copy`),
// an Orrery's own is run on as it is. Then Orrery runs on it at once, no restart, and keeps where it went beside the
// SQLite file NUXT_DATABASE names, for the next start. The one it leaves stays as it was. Not when NUXT_DATABASE is
// Postgres: that one is changed where it's set.
import {existsSync, statSync} from 'node:fs'
import {dirname, isAbsolute, resolve} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import type {H3Event} from 'h3'
import {getRequestHost} from 'h3'
import pg from 'pg'
import type {DatabaseCheck} from '#shared/roadmap'
import {actorOf} from './actor'
import {SqliteDb} from './database'
import {copyDatabase} from './copy'
import {databaseSetting, hidePassword, movedFile, openDb, switchDatabase, useDatabase} from './db'
import {PostgresDb, isPostgres} from './postgres'
import {badRequest, conflict, forbidden} from './input'

/** The names only this machine reaches Orrery by: a move hands the data to wherever it's pointed. */
const THIS_MACHINE = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i

/** Only the owner moves the database, and only on this machine. */
export async function mayMove(event: H3Event) {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner moves the database; send Orrery-Actor: <owner>')
    if (!THIS_MACHINE.test(getRequestHost(event).replace(/:\d+$/, ''))) throw forbidden('The database is moved from the machine Orrery runs on: open it at localhost')
    if (!movedFile()) throw conflict('ORRERY_DATABASE (NUXT_DATABASE) names Postgres, so the database is set there: change it and restart Orrery')
}

/** Where `{kind: "sqlite", path}` or `{kind: "postgres", url}` points: a file (one not starting at / is in the data
 * folder, beside the one NUXT_DATABASE names), or the URL. */
export function targetOf(body: unknown): string {
    const {kind, path, url} = (body ?? {}) as {kind?: unknown, path?: unknown, url?: unknown}
    if (kind === 'sqlite') {
        if (typeof path !== 'string' || !path.trim()) throw badRequest('A SQLite database needs "path": the file to keep it in')
        const file = path.trim()
        const where = isAbsolute(file) ? resolve(file) : resolve(dirname(resolve(String(useRuntimeConfig().database))), file)
        if (existsSync(where) && !statSync(where).isFile()) throw badRequest(`${where} is a folder: name a file in it`)
        return where
    }
    if (kind === 'postgres') {
        if (typeof url !== 'string' || !isPostgres(url.trim())) throw badRequest('A Postgres database needs "url": postgres://user:password@host:5432/name')
        try {
            new URL(url.trim())
        } catch {
            throw badRequest('That Postgres URL doesn\'t read as one: postgres://user:password@host:5432/name')
        }
        return url.trim()
    }
    throw badRequest('"kind" is "sqlite" or "postgres"')
}

/** What's in the database `setting` points to, without changing it. */
export async function checkDatabase(setting: string): Promise<DatabaseCheck> {
    const kind = isPostgres(setting) ? 'postgres' : 'sqlite'
    const where = kind === 'postgres' ? hidePassword(setting) : setting
    if (setting === databaseSetting()) return {kind, where, state: 'current'}
    const tables = kind === 'postgres' ? await postgresTables(setting) : sqliteTables(setting)
    if (!tables) return {kind, where, state: 'empty'}
    if (!tables.names.includes('projects') || !tables.names.includes(kind === 'postgres' ? 'schema_version' : 'issues')) return {kind, where, state: 'other'}
    return {kind, where, state: 'orrery', projects: tables.projects}
}

/** The file's tables and, if it has them, its projects; none when there's no file or nothing in it. */
function sqliteTables(path: string): {names: string[], projects: number} | null {
    if (!existsSync(path)) return null
    let opened: DatabaseSync
    try {
        opened = new DatabaseSync(path, {readOnly: true})
    } catch (error) {
        throw badRequest(`Can't open ${path} as SQLite: ${(error as Error).message}`)
    }
    try {
        const names = (opened.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\'').all() as {name: string}[]).map(t => t.name)
        if (!names.length) return null
        const projects = names.includes('projects') ? Number((opened.prepare('SELECT count(*) AS n FROM projects').get() as {n: number}).n) : 0
        return {names, projects}
    } catch (error) {
        throw badRequest(`Can't read ${path} as SQLite: ${(error as Error).message}`)
    } finally {
        opened.close()
    }
}

/** The tables in the Postgres database's schema and, if it has them, its projects; none when it has no tables. */
async function postgresTables(url: string): Promise<{names: string[], projects: number} | null> {
    const client = new pg.Client({connectionString: url, connectionTimeoutMillis: 8000})
    try {
        await client.connect()
    } catch (error) {
        throw badRequest(`Can't reach ${hidePassword(url)}: ${reason(error)}`)
    }
    try {
        const names = (await client.query<{name: string}>('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()')).rows.map(t => t.name)
        if (!names.length) return null
        const projects = names.includes('projects') ? Number((await client.query<{n: string}>('SELECT count(*) AS n FROM projects')).rows[0]?.n ?? 0) : 0
        return {names, projects}
    } catch (error) {
        throw badRequest(`Can't read ${hidePassword(url)}: ${(error as Error).message}`)
    } finally {
        await client.end().catch(() => {})
    }
}

/** Why a connection failed: a refused one's message can be empty, with only its code (ECONNREFUSED). */
function reason(error: unknown): string {
    const {message, code} = error as {message?: string, code?: string}
    return message || code || 'no answer'
}

/** One move at a time. */
let moving = false

/** Moves to the database `setting` points to: `copy` takes everything into an empty one, `use` runs on an Orrery's
 * own as it is. Says what was copied. What's written while it copies (seconds) stays behind in the one before. */
export async function moveDatabase(setting: string, how: 'copy' | 'use', rebind: (db: SqliteDb | PostgresDb) => void): Promise<{check: DatabaseCheck, copied?: Record<string, number>}> {
    if (moving) throw conflict('The database is already being moved')
    moving = true
    try {
        const check = await checkDatabase(setting)
        if (check.state === 'current') throw conflict('Orrery already runs on that database')
        if (check.state === 'other') throw conflict(`${check.where} has tables of something else's: give Orrery a database of its own`)
        if (how === 'copy' && check.state === 'orrery' && check.projects) throw conflict(`${check.where} is an Orrery's already, with ${check.projects} project${check.projects === 1 ? '' : 's'}: run on it as it is, or copy into an empty one`)
        if (how === 'use' && check.state !== 'orrery') throw conflict(`${check.where} isn't an Orrery's yet: copy this one into it`)
        const target = isPostgres(setting) ? new PostgresDb(setting) : new SqliteDb(openDb(setting))
        let copied: Record<string, number> | undefined
        try {
            // Its schema laid down or brought up to date, as it would be on start.
            await target.get('SELECT 1')
            if (how === 'copy') copied = await copyDatabase(useDatabase(), target)
        } catch (error) {
            if (target instanceof PostgresDb) await target.close()
            else target.raw.close()
            throw error
        }
        rebind(target)
        await switchDatabase(setting, target)
        return {check, ...copied ? {copied} : {}}
    } finally {
        moving = false
    }
}
