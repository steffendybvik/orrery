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
    /** `lastInsertRowid` until inserts say `RETURNING id` (ORR-80). */
    run(sql: string, ...params: Value[]): Promise<{changes: number, lastInsertRowid: number}>
    exec(sql: string): Promise<void>
    /** Runs `work` in one transaction: all of it lands, or none of it. One inside another is part of it. */
    transaction<T>(work: () => Promise<T>): Promise<T>
}

/** The transaction the code running now is part of, if any. */
const current = new AsyncLocalStorage<object>()

export class SqliteDb implements Db {
    readonly dialect = 'sqlite'
    /** The end of the line: what's asked waits for what was asked before it. */
    private tail: Promise<unknown> = Promise.resolve()
    /** The transaction holding the connection, if one is. */
    private open: object | null = null

    constructor(readonly raw: DatabaseSync) {}

    async all<T>(sql: string, ...params: Value[]): Promise<T[]> {
        return this.turn(() => this.raw.prepare(sql).all(...params) as T[])
    }

    async get<T>(sql: string, ...params: Value[]): Promise<T | undefined> {
        return this.turn(() => this.raw.prepare(sql).get(...params) as T | undefined)
    }

    async run(sql: string, ...params: Value[]) {
        return this.turn(() => {
            const {changes, lastInsertRowid} = this.raw.prepare(sql).run(...params)
            return {changes: Number(changes), lastInsertRowid: Number(lastInsertRowid)}
        })
    }

    async exec(sql: string) {
        return this.turn(() => this.raw.exec(sql))
    }

    async transaction<T>(work: () => Promise<T>): Promise<T> {
        if (this.inside()) return work()
        return this.queue(() => {
            const token = {}
            this.open = token
            return current.run(token, async () => {
                this.raw.exec('BEGIN IMMEDIATE')
                try {
                    const result = await work()
                    this.raw.exec('COMMIT')
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
