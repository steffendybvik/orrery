// `pnpm orrery:copy <from> <to>`: copies a whole orrery from one database to another, each a SQLite file
// or a postgres:// URL, e.g. to move to Postgres or back (see server/utils/copy.ts). Stop the orrery using
// the source while it runs, so what it writes after the copy isn't left behind.
import {resolve} from 'node:path'
import type {Db} from '../server/utils/database'
import {SqliteDb} from '../server/utils/database'
import {copyDatabase} from '../server/utils/copy'
import {openDb} from '../server/utils/db'
import {PostgresDb, isPostgres} from '../server/utils/postgres'

// A file is from where the command was run: `pnpm orrery:copy` runs this in web/, and pnpm keeps that in INIT_CWD.
const file = (where: string) => resolve(process.env.INIT_CWD ?? process.cwd(), where)
const open = (where: string): Db => isPostgres(where) ? new PostgresDb(where) : new SqliteDb(openDb(file(where)))
const describe = (where: string) => isPostgres(where) ? where.replace(/\/\/([^:@/]+):[^@]+@/, '//$1:…@') : file(where)

async function main() {
    const [from, to] = process.argv.slice(2)
    if (!from || !to) {
        console.error('Usage: pnpm orrery:copy <from> <to>   (each a SQLite file or a postgres:// URL; the target must be empty)')
        process.exit(1)
    }
    const source = open(from)
    const target = open(to)
    console.log(`Copying ${describe(from)} → ${describe(to)}`)
    const copied = await copyDatabase(source, target)
    for (const [table, n] of Object.entries(copied)) console.log(`  ${table.padEnd(15)} ${n}`)
    console.log('Done.')
    for (const db of [source, target]) if (db instanceof PostgresDb) await db.close()
}

if (process.argv[1] && /copy\.ts$/.test(process.argv[1])) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    })
}
