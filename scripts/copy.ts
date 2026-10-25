// `pnpm orrery:copy <from> <to>`: copies a whole Orrery from one database to another, each a SQLite file
// or a postgres:// URL, e.g. to move to Postgres or back. Every table goes over in order, ids kept, in
// one transaction; the target must be empty (no projects yet), and both are brought up to the latest
// schema first. Stop the Orrery using the source while it runs, so nothing changes under it.
import {resolve} from 'node:path'
import type {Db} from '../server/utils/database'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {PostgresDb, isPostgres} from '../server/utils/postgres'

/** In an order every foreign key is satisfied in, the statuses first (issues point at them). */
const TABLES = ['statuses', 'settings', 'projects', 'chunks', 'issues', 'comments', 'issue_events', 'issue_sessions',
    'issue_aliases', 'chunk_aliases', 'docs', 'schedules', 'schedule_runs', 'signals'] as const
/** The tables whose ids the database hands out, so Postgres's counters move on past the copied ones. */
const NUMBERED = ['comments', 'issue_events', 'schedules', 'schedule_runs', 'signals']

const open = (where: string): Db => isPostgres(where) ? new PostgresDb(where) : new SqliteDb(openDb(resolve(where)))
const describe = (where: string) => isPostgres(where) ? where.replace(/\/\/([^:@/]+):[^@]+@/, '//$1:…@') : resolve(where)

export async function copy(source: Db, target: Db): Promise<Record<string, number>> {
    if ((await target.get<{n: number}>('SELECT count(*) AS n FROM projects'))!.n) throw new Error('The target already has projects: copy into an empty Orrery')
    const copied: Record<string, number> = {}
    await target.transaction(async () => {
        await target.deferConstraints()
        // A new database starts with the default statuses; the source's replace them.
        await target.run('DELETE FROM statuses')
        await target.run('DELETE FROM settings')
        for (const table of TABLES) {
            const rows = await source.all<Record<string, unknown>>(`SELECT * FROM ${table}`)
            for (const row of rows) {
                const columns = Object.keys(row)
                await target.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
                    ...columns.map(column => row[column] as never))
            }
            copied[table] = rows.length
        }
        if (target.dialect === 'postgres') {
            for (const table of NUMBERED) {
                await target.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`)
            }
        }
    })
    return copied
}

async function main() {
    const [from, to] = process.argv.slice(2)
    if (!from || !to) {
        console.error('Usage: pnpm orrery:copy <from> <to>   (each a SQLite file or a postgres:// URL; the target must be empty)')
        process.exit(1)
    }
    const source = open(from)
    const target = open(to)
    console.log(`Copying ${describe(from)} → ${describe(to)}`)
    const copied = await copy(source, target)
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
