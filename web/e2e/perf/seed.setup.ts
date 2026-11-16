import {DatabaseSync} from 'node:sqlite'
import pg from 'pg'
import {expect, test} from '@playwright/test'
import type {Actor, Call, Rows, Value} from './seed'
import {seed, sizesFrom} from './seed'

// Fills the orrery the perf run measures (seed.ts, ORR-1240), once the built server and its API are up: over HTTP, with
// the bulk rows written into the same database (`PERF_DATABASE`, as playwright.perf.config.ts names it). It opens the
// database plainly, as migrating it is the API's. perf.spec.ts runs after.

/** A SQLite file, or a Postgres URL with its `?` placeholders numbered, on one connection so a transaction holds. */
async function open(where: string): Promise<Rows & {close(): Promise<void>}> {
    if (!/^postgres(ql)?:\/\//.test(where)) {
        const db = new DatabaseSync(where)
        db.exec('PRAGMA busy_timeout = 10000')
        return {
            run: async (sql, ...params) => db.prepare(sql).run(...params),
            all: async <T>(sql: string, ...params: Value[]) => db.prepare(sql).all(...params) as T[],
            transaction: async work => {
                db.exec('BEGIN IMMEDIATE')
                try {
                    await work()
                    db.exec('COMMIT')
                } catch (error) {
                    db.exec('ROLLBACK')
                    throw error
                }
            },
            close: async () => db.close(),
        }
    }
    const client = new pg.Client({connectionString: where})
    await client.connect()
    const numbered = (sql: string) => {
        let n = 0
        return sql.replace(/\?/g, () => `$${++n}`)
    }
    const query = (sql: string, params: Value[]) => client.query(numbered(sql), params)
    return {
        run: (sql, ...params) => query(sql, params),
        all: async <T>(sql: string, ...params: Value[]) => (await query(sql, params)).rows as T[],
        transaction: async work => {
            await client.query('BEGIN')
            try {
                await work()
                await client.query('COMMIT')
            } catch (error) {
                await client.query('ROLLBACK')
                throw error
            }
        },
        close: () => client.end(),
    }
}

test('seeds a big orrery', async ({request}) => {
    test.setTimeout(900_000)
    const db = await open(process.env.PERF_DATABASE!)
    const call: Call = async (method, path, body, actor: Actor = 'claude') => {
        const reply = await request.fetch(path, {method, data: body, headers: {'Orrery-Actor': actor}})
        expect(reply.ok(), `${method} ${path}: ${await reply.text()}`).toBeTruthy()
        return reply.json()
    }
    const started = Date.now()
    try {
        const counts = await seed(call, db, sizesFrom(process.env), line => console.log(`[seed] ${line}`))
        console.log(`[seed] done in ${((Date.now() - started) / 1000).toFixed(1)}s:`, JSON.stringify(counts))
    } finally {
        await db.close()
    }
})
