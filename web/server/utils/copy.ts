// Copies a whole Orrery from one database to another, each SQLite or Postgres: `pnpm orrery:copy`, to move to
// Postgres or back, and a Postgres Orrery's backups, a SQLite snapshot. Every table is read in one transaction, so
// what's copied is one moment's, then written in order, ids kept, in one transaction; the target must be empty
// (no projects yet), and both are brought up to the latest schema first.
import type {Db} from './database'
import {one} from './database'

/** In an order every foreign key is satisfied in, the statuses first (issues point at them). */
export const COPIED_TABLES = ['statuses', 'settings', 'projects', 'releases', 'chunks', 'issues', 'comments', 'issue_events', 'issue_sessions',
    'issue_aliases', 'chunk_aliases', 'docs', 'schedules', 'schedule_runs', 'signals', 'secrets', 'secret_uses', 'uploads', 'presets'] as const
/** The tables whose ids the database hands out, so Postgres's counters move on past the copied ones. */
const NUMBERED = ['comments', 'issue_events', 'schedules', 'schedule_runs', 'signals', 'secret_uses', 'presets']

export async function copyDatabase(source: Db, target: Db): Promise<Record<string, number>> {
    if ((await one<{n: number}>(target, 'SELECT count(*) AS n FROM projects')).n) throw new Error('The target already has projects: copy into an empty Orrery')
    // Read first, all of it in one transaction (on Postgres one snapshot of it), so a write while it copies a
    // running Orrery can't leave a row pointing at one that isn't there.
    const rows = await source.transaction(async () => {
        if (source.dialect === 'postgres') await source.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        const read: Partial<Record<(typeof COPIED_TABLES)[number], Record<string, unknown>[]>> = {}
        for (const table of COPIED_TABLES) read[table] = await source.all<Record<string, unknown>>(`SELECT * FROM ${table}`)
        return read
    })
    const copied: Record<string, number> = {}
    await target.transaction(async () => {
        await target.deferConstraints()
        // A new database starts with the default statuses; the source's replace them.
        await target.run('DELETE FROM statuses')
        await target.run('DELETE FROM settings')
        for (const table of COPIED_TABLES) {
            for (const row of rows[table] ?? []) {
                const columns = Object.keys(row)
                await target.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
                    ...columns.map(column => row[column] as never))
            }
            copied[table] = rows[table]?.length ?? 0
        }
        if (target.dialect === 'postgres') {
            for (const table of NUMBERED) {
                await target.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`)
            }
        }
    })
    return copied
}
