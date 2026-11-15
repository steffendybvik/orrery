// The real Rust API for a unit test (ORR-1163): since rc.19 the server needs the API, so a test of what reads or writes
// through it (`readFromApi`, `writeToApi`) runs the binary `cargo build` makes (api/target/debug/orrery-api, or
// ORRERY_API_BIN), on the test's own database, rather than a fallback to the store that the server no longer has.
//
//     const store = new Store(apiTestDb())
//     await withApi(store)
//
// `apiTestDb()` is `testDb()` on a database the API can open too: a file of its own in place of SQLite's `:memory:`, or
// with TEST_POSTGRES_URL a schema of its own. `withApi` starts the API on it and points this server's router at it, in
// the runtime config, with `useStore` and `databaseSetting` stubbed to match; each test's API stops when the test ends.
// The global setup (`test/global-setup.ts`) builds the binary before a run. A test moved over keeps no fallback to the
// store: what it checks goes through the API as it does on a server.
import type {ChildProcess} from 'node:child_process'
import {spawn} from 'node:child_process'
import {existsSync, mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, vi} from 'vitest'
import type {Db} from '../server/utils/database'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {PostgresDb} from '../server/utils/postgres'
import {Store} from '../server/utils/store'
import {forgetRoster} from '../server/utils/roster'

const API_BIN = process.env.ORRERY_API_BIN || fileURLToPath(new URL('../../api/target/debug/orrery-api', import.meta.url))
const TOKEN = 'unit-test-token-0123456789'
const POSTGRES = process.env.TEST_POSTGRES_URL

/** Where each of `apiTestDb`'s databases is, as the API is told: the file's path, or Postgres's address and schema. */
const where = new WeakMap<Db, {setting: string, schema?: string}>()

/** The APIs started in this test, and the pools to close once they've stopped. */
const running: ChildProcess[] = []
const pools: PostgresDb[] = []
/** The runtime config this test's API is named in. */
let config: Record<string, string> = {}

afterEach(async () => {
    if (!running.length && !pools.length) return
    await Promise.all(running.splice(0).map(stop))
    config = {}
    forgetRoster()
    await Promise.all(pools.splice(0).map(db => db.close()))
})

// A worker that ends mid-test leaves no API behind.
process.once('exit', () => {
    for (const api of running) api.kill('SIGKILL')
})

/** A test's database that the API can open too: SQLite in a file of its own, or a Postgres schema of its own. */
export function apiTestDb(): Db {
    if (POSTGRES) {
        const schema = `test_api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        const db = new PostgresDb(POSTGRES, schema)
        pools.push(db)
        where.set(db, {setting: POSTGRES, schema})
        return db
    }
    const setting = join(mkdtempSync(join(tmpdir(), 'orrery-unit-')), 'orrery.db')
    const db = new SqliteDb(openDb(setting))
    where.set(db, {setting})
    return db
}

/** Starts the API on `store`'s database (one of `apiTestDb`'s) and points the router at it, until the test ends.
 * `useStore` and `databaseSetting` are stubbed to `store` and its database, as the router reads them. */
export async function withApi(store: Store, env: Record<string, string> = {}): Promise<{url: string, token: string}> {
    const at = where.get(store.db)
    if (!at) throw new Error('withApi needs a store on apiTestDb(): the API has to open the same database')
    if (!existsSync(API_BIN)) throw new Error(`no Rust API at ${API_BIN}: run \`cargo build\` in api/ (the global setup does, with cargo installed)`)
    // The schema first, so the API finds it laid down (SQLite's `openDb` has already).
    if (store.db instanceof PostgresDb) await store.db.all('SELECT 1')
    const api = spawn(API_BIN, [], {env: {...process.env, NUXT_API_TOKEN: TOKEN, NUXT_DATABASE: at.setting, ORRERY_API_LISTEN: '127.0.0.1:0', ...at.schema ? {ORRERY_API_SCHEMA: at.schema} : {}, ...env}})
    running.push(api)
    const url = await new Promise<string>((done, fail) => {
        let said = ''
        api.stderr!.on('data', (chunk: Buffer) => {
            said += chunk
            const heard = /serving docs on (http:\/\/\S+),/.exec(said)
            if (heard) done(heard[1]!)
        })
        api.once('exit', code => fail(new Error(`the API stopped (${code}): ${said}`)))
    })
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('databaseSetting', () => at.setting)
    // What a relayed write tells (api-router.ts `relayed`), heard by nothing in a unit test unless it stubs its own.
    const globals = globalThis as Record<string, unknown>
    if (!globals.useScheduler) vi.stubGlobal('useScheduler', () => ({changedElsewhere: () => {}}))
    if (!globals.useEventLog) vi.stubGlobal('useEventLog', () => ({note: () => {}, activity: async () => {}}))
    // Through the runtime config rather than `apiStarted`, which a test's `vi.resetModules()` would leave on a copy of
    // the router it no longer uses. A test that stubs the config itself after this spreads `apiConfig()` into it.
    const before = (globalThis as {useRuntimeConfig?: () => Record<string, unknown>}).useRuntimeConfig
    config = {apiUrl: url, apiToken: TOKEN, database: at.setting}
    vi.stubGlobal('useRuntimeConfig', () => ({...before?.(), ...config}))
    forgetRoster()
    return {url, token: TOKEN}
}

/** A store on a database of its own with the API running on it, as `new Store(testDb(), …)` was before the store's
 * fallbacks went (ORR-1135): what it reads and writes goes through the API as it does on a server. */
export async function apiStore(...rest: ConstructorParameters<typeof Store> extends [unknown, ...infer R] ? R : never): Promise<Store> {
    const store = new Store(apiTestDb(), ...rest)
    await withApi(store)
    return store
}

/** What points the router at this test's API (`apiUrl`, `apiToken`) and names its database, for a test that stubs
 * `useRuntimeConfig` itself after `withApi`. */
export function apiConfig(): Record<string, string> {
    return {...config}
}

/** Stops `api`, waiting for it to go so its database is free. */
function stop(api: ChildProcess): Promise<void> {
    if (api.exitCode !== null || api.signalCode !== null) return Promise.resolve()
    return new Promise(done => {
        api.once('exit', () => done())
        api.kill()
    })
}
