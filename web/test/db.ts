// The database a test's store runs on: SQLite in memory, or with TEST_POSTGRES_URL set, a schema of its
// own in that Postgres, so the same tests check both drivers. A test's pool closes when it ends, so the
// runs don't pile up connections past what Postgres allows.
import {afterEach} from 'vitest'
import type {Db} from '../server/utils/database'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {PostgresDb} from '../server/utils/postgres'

export const onPostgres = !!process.env.TEST_POSTGRES_URL

const open: PostgresDb[] = []
afterEach(async () => {
    await Promise.all(open.splice(0).map(db => db.close()))
})

export function testDb(): Db {
    if (!onPostgres) return new SqliteDb(openDb(':memory:'))
    const db = new PostgresDb(process.env.TEST_POSTGRES_URL!, `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
    open.push(db)
    return db
}
