// Moving to another database from App settings: a SQLite file on this machine, or Postgres. It's checked first
// (`POST /api/database/check`): an empty one has everything copied into it (the same copy as `pnpm orrery:copy`),
// an orrery's own is run on as it is. Then orrery runs on it at once, no restart, and keeps where it went beside the
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
import {inDocker} from './backup-choice'
import {SqliteDb} from './database'
import {copyDatabase} from './copy'
import {beforeUpgrade, databaseSetting, hidePassword, movedFile, openDb, switchDatabase, useDatabase} from './db'
import {PostgresDb, isPostgres} from './postgres'
import {badRequest, conflict, forbidden} from './input'
import {ownerOnly} from './permission'

/** The names only this machine reaches orrery by: a move hands the data to wherever it's pointed. */
const THIS_MACHINE = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i
/** A loopback address, as a connection comes from (`::ffff:127.0.0.1` over IPv6) or as orrery is published on. */
const LOOPBACK = /^(127(\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(\.\d{1,3}){3}|localhost)$/i

/** Whether the request came from the machine orrery runs on. The name it was reached by has to be this machine's, but
 * that's the `Host` header, which the caller chooses (ORR-421), so the connection has to say so too: outside Docker, it
 * comes from a loopback address (see `clientAddress`); in Docker, where every request comes through the bridge, orrery has to be published on
 * loopback alone (`ORRERY_HOST`, 127.0.0.1 by default, which compose passes in as NUXT_LISTEN_HOST). */
export function fromThisMachine(event: H3Event): boolean {
    if (!THIS_MACHINE.test(getRequestHost(event).replace(/:\d+$/, ''))) return false
    // A reverse proxy on this machine makes every request come from it, whoever sent it: one it passes on says so in
    // these headers, so it isn't taken as local (ORR-457). `nuxt dev` adds its own, to a request with no socket address.
    const {headers} = event.node.req
    if (event.node.req.socket?.remoteAddress && ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'].some(name => headers[name] !== undefined)) return false
    if (inDocker()) return LOOPBACK.test(String(useRuntimeConfig().listenHost ?? ''))
    return LOOPBACK.test(clientAddress(event))
}

/** Where the connection comes from. `nuxt dev` hands each request to its server over a local socket, which has no
 * address, and puts the client's last in `X-Forwarded-For` (after any the client sent itself), so it's read there then. */
function clientAddress(event: H3Event): string {
    const socket = event.node.req.socket?.remoteAddress
    if (socket) return socket
    const forwarded = event.node.req.headers['x-forwarded-for']
    return String(Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').at(-1)?.trim() ?? ''
}

/** Why a request isn't from this machine, for `what` ("The database is moved"). */
export const notThisMachine = (what: string) => inDocker() && !LOOPBACK.test(String(useRuntimeConfig().listenHost ?? ''))
    ? `${what} only while orrery is reachable from its own machine alone, and ORRERY_HOST opens it to the network: set it back to 127.0.0.1 for the change, or make it outside the app`
    : `${what} from the machine orrery runs on: open it at localhost`

/** Only the owner moves the database, and only on this machine. */
export async function mayMove(event: H3Event) {
    const actor = await actorOf(event)
    ownerOnly(actor, 'database.write')
    if (!fromThisMachine(event)) throw forbidden(notThisMachine('The database is moved'))
    if (!movedFile()) throw conflict('ORRERY_DATABASE (NUXT_DATABASE) names Postgres, so the database is set there: change it and restart orrery')
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

/** What the Postgres database at `url` holds, read without writing to it: nothing, an orrery's tables, or something
 * else's. */
export async function postgresHolds(url: string): Promise<'empty' | 'orrery' | 'other'> {
    const tables = await postgresTables(url)
    if (!tables) return 'empty'
    return tables.names.includes('projects') && tables.names.includes('schema_version') ? 'orrery' : 'other'
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

/** Moves to the database `setting` points to: `copy` takes everything into an empty one, `use` runs on an orrery's
 * own as it is. Says what was copied. What's written while it copies (seconds) stays behind in the one before. */
export async function moveDatabase(setting: string, how: 'copy' | 'use', rebind: (db: SqliteDb | PostgresDb) => void): Promise<{check: DatabaseCheck, copied?: Record<string, number>}> {
    if (moving) throw conflict('The database is already being moved')
    moving = true
    try {
        const check = await checkDatabase(setting)
        if (check.state === 'current') throw conflict('orrery already runs on that database')
        if (check.state === 'other') throw conflict(`${check.where} has tables of something else's: give orrery a database of its own`)
        if (how === 'copy' && check.state === 'orrery' && check.projects) throw conflict(`${check.where} is an orrery's already, with ${check.projects} project${check.projects === 1 ? '' : 's'}: run on it as it is, or copy into an empty one`)
        if (how === 'use' && check.state !== 'orrery') throw conflict(`${check.where} isn't an orrery's yet: copy this one into it`)
        // An older orrery's file is upgraded as it opens, so it's copied first, as on start.
        const target = isPostgres(setting) ? new PostgresDb(setting) : new SqliteDb(openDb(setting, undefined, beforeUpgrade(setting)))
        let copied: Record<string, number> | undefined
        try {
            // Its schema laid down or brought up to date, as it would be on start.
            await target.get('SELECT 1')
            if (how === 'copy') copied = await copyDatabase(useDatabase(), target)
            // Where it went is saved before anything writes to it: a save that fails (a full disk) leaves it all
            // on the one before, not the store on one and the rest on the other.
            await switchDatabase(setting, target, rebind)
        } catch (error) {
            // Not once it runs on it, if only letting go of the one before failed.
            if (databaseSetting() !== setting) {
                if (target instanceof PostgresDb) await target.close()
                else target.raw.close()
            }
            throw error
        }
        return {check, ...copied ? {copied} : {}}
    } finally {
        moving = false
    }
}
