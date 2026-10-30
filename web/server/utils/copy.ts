// Copies a whole orrery from one database to another, each SQLite or Postgres: `pnpm orrery:copy`, to move to
// Postgres or back, and the backups, a SQLite snapshot or a Postgres database. Every table is read in one transaction,
// so what's copied is one moment's, then written in order, ids kept, in one transaction; the target must be empty
// (no projects yet), unless `replace` empties it in that same transaction (a backup taking the place of the last, which
// stays whole if this one fails), and both are brought up to the latest schema first.
import type {Db} from './database'
import {one} from './database'

/** In an order every foreign key is satisfied in, the statuses first (issues point at them). */
export const COPIED_TABLES = ['statuses', 'settings', 'people', 'keys', 'logins', 'identities', 'invites', 'projects', 'project_members', 'releases', 'chunks', 'issues', 'comments', 'notice_clears', 'schedule_requests', 'issue_events', 'issue_sessions', 'session_people',
    'issue_aliases', 'issue_links', 'chunk_aliases', 'docs', 'doc_sections', 'doc_revisions', 'schedules_across', 'schedules', 'schedule_runs', 'schedule_held', 'signals', 'secrets', 'secret_uses', 'uploads', 'presets', 'preset_defaults', 'events', 'proposal_clears', 'pull_states', 'pull_repos'] as const
/** The tables whose ids the database hands out, so Postgres's counters move on past the copied ones. */
const NUMBERED = ['comments', 'issue_events', 'doc_revisions', 'schedules_across', 'schedules', 'schedule_runs', 'signals', 'secret_uses', 'presets', 'events']

/** `mark` is written into the target's settings as `backup_of`: the id of the orrery it's a backup of. */
export async function copyDatabase(source: Db, target: Db, {replace = false, mark}: {replace?: boolean, mark?: string} = {}): Promise<Record<string, number>> {
    if (!replace && (await one<{n: number}>(target, 'SELECT count(*) AS n FROM projects')).n) throw new Error('The target already has projects: copy into an empty orrery')
    // Read first, all of it in one transaction (on Postgres one snapshot of it), so a write while it copies a
    // running orrery can't leave a row pointing at one that isn't there.
    const rows = await source.transaction(async () => {
        if (source.dialect === 'postgres') await source.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        const read: Partial<Record<(typeof COPIED_TABLES)[number], Record<string, unknown>[]>> = {}
        for (const table of COPIED_TABLES) read[table] = await source.all<Record<string, unknown>>(`SELECT * FROM ${table}`)
        return read
    })
    const copied: Record<string, number> = {}
    await target.transaction(async () => {
        await target.deferConstraints()
        if (replace) for (const table of [...COPIED_TABLES].reverse()) await target.run(`DELETE FROM ${table}`)
        // A new database starts with the default statuses, and may have had the presets orrery ships seeded; the source's replace them.
        await target.run('DELETE FROM statuses')
        await target.run('DELETE FROM settings')
        await target.run('DELETE FROM people')
        await target.run('DELETE FROM presets')
        await target.run('DELETE FROM preset_defaults')
        for (const table of COPIED_TABLES) {
            for (const row of rows[table] ?? []) {
                const columns = Object.keys(row)
                await target.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
                    ...columns.map(column => row[column] as never))
            }
            copied[table] = rows[table]?.length ?? 0
        }
        // Over the source's own, if it was started from a backup.
        if (mark) await target.run('INSERT INTO settings (key, value) VALUES (\'backup_of\', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', JSON.stringify(mark))
        if (target.dialect === 'postgres') {
            for (const table of NUMBERED) {
                await target.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`)
            }
        }
    })
    return copied
}
