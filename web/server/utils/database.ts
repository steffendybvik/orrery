// What the store talks to: a database it awaits, so the same store can run on SQLite now and on
// Postgres later. SQLite's driver wraps `node:sqlite`, which answers at once, and keeps the one
// connection to one thing at a time: a transaction holds it until it ends, and what runs inside the
// transaction (found through AsyncLocalStorage) goes straight through, so writes never interleave.
import {AsyncLocalStorage} from 'node:async_hooks'
import type {DatabaseSync, SQLInputValue} from 'node:sqlite'

export type Value = SQLInputValue

export interface Db {
    readonly dialect: 'sqlite' | 'postgres'
    all<T>(sql: string, ...params: Value[]): Promise<T[]>
    get<T>(sql: string, ...params: Value[]): Promise<T | undefined>
    /** `changes`: how many rows it touched. An insert that needs its id says `RETURNING id` and goes through `get`. */
    run(sql: string, ...params: Value[]): Promise<{changes: number}>
    exec(sql: string): Promise<void>
    /** Holds the foreign keys until the transaction commits, for writes that change ids rows point at. */
    deferConstraints(): Promise<void>
    /** Runs `work` in one transaction: all of it lands, or none of it. One inside another is part of it. */
    transaction<T>(work: () => Promise<T>): Promise<T>
    /** Runs `work` once the transaction the code running now is part of commits (never, when it rolls back), outside
     * it; when there's none, on the next turn. */
    afterCommit(work: () => void): void
    /** Runs `work` inside the transaction the code running now is part of, just before it commits, so it lands or
     * rolls back with it: the outbox's rows (ORR-929). One with a `key` already waiting isn't added again. When there's
     * no transaction, it runs at once, on its own. */
    beforeCommit(work: () => Promise<unknown>, key?: string): void
    /** Runs `work` the moment the transaction the code running now is part of commits (never, when it rolls back),
     * outside it and before the transaction's caller carries on, so it's as prompt as code after the transaction was.
     * When there's none, at once. */
    atCommit(work: () => void): void
}

/** What waits on a transaction: `before`, run inside it just before it commits, and `after`, once it has. */
export interface Waiting {
    before: Map<string | symbol, () => Promise<unknown>>
    at: (() => void)[]
    after: (() => void)[]
}

/** Runs what waits for the commit itself, outside every transaction of `storage`, at once. */
export function runAt(storage: AsyncLocalStorage<unknown>, at: (() => void)[]) {
    // The write has committed: a failure here is said, not thrown, so it isn't taken for the write's.
    if (at.length) storage.exit(() => at.forEach(work => {
        try {
            work()
        } catch (error) {
            console.error('[orrery] after a commit:', error)
        }
    }))
}

/** Runs what waits to go in just before the commit, in the order it came, in the transaction. */
export async function runBefore(waiting: Waiting) {
    for (const work of waiting.before.values()) await work()
}

/** Adds `work` to run before the commit, unless one with its `key` is there already. */
export function addBefore(waiting: Waiting, work: () => Promise<unknown>, key?: string) {
    const at = key ?? Symbol('before')
    if (!waiting.before.has(at)) waiting.before.set(at, work)
}

/** Runs `work` now, on its own, as there's no transaction to wait for; a failure is said, not thrown, as nothing awaits it. */
export function runAlone(work: () => Promise<unknown>) {
    work().catch(error => console.error('[orrery] writing to the outbox:', error))
}

/** The row of a statement that always gives one (an insert or update `RETURNING`, a `count(*)`); none is a bug, not a missing record. */
export async function one<T>(db: Db, sql: string, ...params: Value[]): Promise<T> {
    const row = await db.get<T>(sql, ...params)
    if (row === undefined) throw new Error(`Expected a row from: ${sql.slice(0, 80)}`)
    return row
}

/** The transaction the code running now is part of, if any, with what waits for it to commit. */
const current = new AsyncLocalStorage<Waiting>()

/** Runs each of `after`, outside every transaction of `storage`, on the next turn. */
export function runAfter(storage: AsyncLocalStorage<unknown>, after: (() => void)[]) {
    if (after.length) storage.exit(() => setImmediate(() => after.forEach(work => work())))
}

export class SqliteDb implements Db {
    readonly dialect = 'sqlite'
    /** The end of the line: what's asked waits for what was asked before it. */
    private tail: Promise<unknown> = Promise.resolve()
    /** The transaction holding the connection, if one is. */
    private open: Waiting | null = null

    constructor(readonly raw: DatabaseSync) {}

    async all<T>(sql: string, ...params: Value[]): Promise<T[]> {
        return this.turn(() => this.raw.prepare(sql).all(...params) as T[])
    }

    async get<T>(sql: string, ...params: Value[]): Promise<T | undefined> {
        return this.turn(() => this.raw.prepare(sql).get(...params) as T | undefined)
    }

    async run(sql: string, ...params: Value[]) {
        return this.turn(() => {
            return {changes: Number(this.raw.prepare(sql).run(...params).changes)}
        })
    }

    async exec(sql: string) {
        return this.turn(() => this.raw.exec(sql))
    }

    async deferConstraints() {
        return this.exec('PRAGMA defer_foreign_keys = ON')
    }

    async transaction<T>(work: () => Promise<T>): Promise<T> {
        if (this.inside()) return work()
        return this.queue(() => {
            const token: Waiting = {before: new Map(), at: [], after: []}
            this.open = token
            return current.run(token, async () => {
                this.raw.exec('BEGIN IMMEDIATE')
                try {
                    const result = await work()
                    await runBefore(token)
                    this.raw.exec('COMMIT')
                    this.open = null
                    runAt(current, token.at)
                    runAfter(current, token.after)
                    return result
                } catch (error) {
                    this.raw.exec('ROLLBACK')
                    throw error
                } finally {
                    this.open = null
                }
            })
        })
    }

    afterCommit(work: () => void) {
        if (this.inside()) this.open?.after.push(work)
        else runAfter(current, [work])
    }

    beforeCommit(work: () => Promise<unknown>, key?: string) {
        if (this.inside() && this.open) addBefore(this.open, work, key)
        else runAlone(work)
    }

    atCommit(work: () => void) {
        if (this.inside() && this.open) this.open.at.push(work)
        else work()
    }

    /** Hands the raw connection to `work` when nothing else holds it, e.g. for a backup (`VACUUM INTO`
     * can't run inside a transaction). */
    async alone<T>(work: (raw: DatabaseSync) => T): Promise<T> {
        return this.queue(() => work(this.raw))
    }

    /** Inside the open transaction, at once; otherwise in line. */
    private turn<T>(work: () => T): Promise<T> {
        return this.inside() ? Promise.resolve().then(work) : this.queue(work)
    }

    private inside(): boolean {
        const token = current.getStore()
        return !!token && token === this.open
    }

    private queue<T>(work: () => T | Promise<T>): Promise<T> {
        const result = this.tail.then(work)
        this.tail = result.catch(() => {})
        return result
    }
}
