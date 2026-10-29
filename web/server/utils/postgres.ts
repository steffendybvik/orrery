// Postgres behind the same `Db` the store awaits (server/utils/database.ts), for an orrery given a
// `postgres://` URL. A pool serves what comes in at once; a transaction holds one connection, and what
// runs inside it (found through AsyncLocalStorage) goes to that connection. The SQL is the store's own,
// written so SQLite and Postgres both understand it; `?` placeholders become `$1, $2, …` here.
//
// The schema starts from one baseline, SQLite's schema at step BASELINE written for Postgres, and is
// tracked in `schema_version`. A step after it is added to both: SQLite's numbered steps in migrations/sqlite.ts,
// and Postgres's in migrations/postgres.ts.
import {AsyncLocalStorage} from 'node:async_hooks'
import pg from 'pg'
import {runAfter, type Db, type Value} from './database'
import {redact} from './event-log'
import {BASELINE, SCHEMA, STEPS} from './migrations/postgres'

// Counts come back as int8, which pg hands over as text; orrery's never outgrow a number.
pg.types.setTypeParser(pg.types.builtins.INT8, value => Number(value))

/** The transaction the code running now is part of, if any: its connection, the database it's on, and whether
 * it's still open (work it started can outlive its COMMIT, and then goes to the pool, not a released client). */
const current = new AsyncLocalStorage<{db: PostgresDb, client: pg.PoolClient, open: boolean, after: (() => void)[]}>()

export class PostgresDb implements Db {
    readonly dialect = 'postgres'
    readonly pool: pg.Pool
    /** The schema, once it's up to date; every query waits for it. */
    private readonly ready: Promise<void>
    /** The versions the schema was brought from and to as this opened, for the event log; null when it was up to date. */
    migrated: {from: number, to: number} | null = null

    /** `schema` puts the tables in a schema of their own (tests give each run one); `public` by default. `upTo` stops
     * at that step, never below the baseline, as `openDb`'s does (tests, for data to upgrade). */
    constructor(url: string, schema?: string, upTo = BASELINE + STEPS.length) {
        this.pool = new pg.Pool({connectionString: url, max: 10, allowExitOnIdle: true})
        if (schema) this.pool.on('connect', client => void client.query(`SET search_path TO "${schema}"`))
        // An idle connection dropping (Postgres restarting) is said, not thrown: unheard, it would end the server. The
        // pool opens another for the next query.
        this.pool.on('error', error => console.error('[orrery] postgres connection lost:', redact(error.message)))
        this.ready = this.migrate(schema, upTo)
        // A failed start shows when the first query is made; this only keeps it from going unhandled.
        this.ready.catch(() => {})
    }

    async all<T>(sql: string, ...params: Value[]): Promise<T[]> {
        return (await this.query(sql, params)).rows as T[]
    }

    async get<T>(sql: string, ...params: Value[]): Promise<T | undefined> {
        return (await this.query(sql, params)).rows[0] as T | undefined
    }

    async run(sql: string, ...params: Value[]) {
        return {changes: (await this.query(sql, params)).rowCount ?? 0}
    }

    async exec(sql: string) {
        await this.query(sql, [])
    }

    async deferConstraints() {
        await this.exec('SET CONSTRAINTS ALL DEFERRED')
    }

    async transaction<T>(work: () => Promise<T>): Promise<T> {
        if (this.ongoing()) return work()
        await this.ready
        const client = await this.pool.connect()
        const transaction = {db: this, client, open: true, after: [] as (() => void)[]}
        try {
            await client.query('BEGIN')
            const result = await current.run(transaction, work)
            await client.query('COMMIT')
            runAfter(current, transaction.after)
            return result
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {})
            throw error
        } finally {
            transaction.open = false
            client.release()
        }
    }

    afterCommit(work: () => void) {
        const transaction = this.ongoing()
        if (transaction) transaction.after.push(work)
        else runAfter(current, [work])
    }

    /** The open transaction of this database the code running now is part of, if any. */
    private ongoing() {
        const transaction = current.getStore()
        return transaction?.db === this && transaction.open ? transaction : undefined
    }

    async close() {
        await this.pool.end()
    }

    private async query(sql: string, params: Value[]) {
        await this.ready
        const text = numbered(sql)
        const values = params.map(value => typeof value === 'bigint' ? Number(value) : value)
        const transaction = this.ongoing()
        return transaction ? transaction.client.query(text, values) : this.pool.query(text, values)
    }

    /** Lays down the baseline on an empty database, then the steps after it; one server at a time. */
    private async migrate(schema: string | undefined, upTo: number) {
        const client = await this.pool.connect()
        try {
            if (schema) await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"; SET search_path TO "${schema}"`)
            await client.query('BEGIN')
            // Two servers starting at once wait for each other here.
            await client.query('SELECT pg_advisory_xact_lock(4207)')
            await client.query('CREATE TABLE IF NOT EXISTS schema_version (version integer NOT NULL)')
            const row = (await client.query<{version: number}>('SELECT version FROM schema_version')).rows[0]
            let version = row?.version ?? 0
            // One from a newer orrery is left as it is (ORR-433); its steps all ran in one transaction, so no copy is needed.
            if (version > BASELINE + STEPS.length) {
                throw new Error(`This Postgres database was written by a newer orrery (schema step ${version}; this one knows up to ${BASELINE + STEPS.length}). `
                    + 'Run that version again, or restore a backup from before it upgraded.')
            }
            if (!row) {
                await client.query(SCHEMA)
                await client.query('INSERT INTO schema_version (version) VALUES ($1)', [BASELINE])
                version = BASELINE
            }
            const from = row?.version ?? 0
            for (const [i, step] of STEPS.entries()) {
                if (version >= BASELINE + i + 1) continue
                if (BASELINE + i + 1 > upTo) break
                await client.query(step)
                await client.query('UPDATE schema_version SET version = $1', [BASELINE + i + 1])
                version = BASELINE + i + 1
            }
            await client.query('COMMIT')
            if (from < version) this.migrated = {from, to: version}
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {})
            throw error
        } finally {
            client.release()
        }
    }
}

/** `?` placeholders as Postgres numbers them (`$1, $2, …`), leaving quoted text alone. */
export function numbered(sql: string): string {
    let n = 0
    let quoted = false
    let out = ''
    for (const char of sql) {
        if (char === "'") quoted = !quoted
        out += char === '?' && !quoted ? `$${++n}` : char
    }
    return out
}

/** Whether a database setting names Postgres rather than a SQLite file. */
export const isPostgres = (database: string) => /^postgres(ql)?:\/\//.test(database)
