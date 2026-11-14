// Copies a whole orrery from one database to another, each SQLite or Postgres: `pnpm orrery:copy`, to move to
// Postgres or back, with orrery stopped. Every table is read in one transaction, so what's copied is one moment's,
// then written in order, ids kept, in one transaction; the target must be empty (no projects yet), and both are
// brought up to the latest schema first.
import type {Db} from './database'
import {one} from './database'

/** In an order every foreign key is satisfied in, the statuses first (issues point at them). */
export const COPIED_TABLES = ['statuses', 'settings', 'people', 'workspaces', 'workspace_members', 'keys', 'logins', 'identities', 'invites', 'projects', 'project_members', 'releases', 'milestones', 'epics', 'issues', 'comments', 'milestone_comments', 'epic_comments', 'notice_clears', 'notice_reads', 'schedule_requests', 'issue_events', 'issue_sessions', 'issue_pulls', 'session_people',
    'issue_aliases', 'issue_links', 'milestone_aliases', 'docs', 'doc_sections', 'doc_revisions', 'schedules_across', 'schedules', 'schedule_runs', 'schedule_held', 'signals', 'secrets', 'secret_uses', 'uploads', 'presets', 'preset_defaults', 'events', 'changes', 'proposal_clears', 'pull_states', 'pull_repos', 'chats', 'chat_messages', 'feature_use'] as const
/** The tables whose ids the database hands out, so Postgres's counters move on past the copied ones. */
const NUMBERED = ['epics', 'comments', 'milestone_comments', 'epic_comments', 'issue_events', 'doc_revisions', 'schedules_across', 'schedules', 'schedule_runs', 'signals', 'secret_uses', 'presets', 'events', 'changes']

/** Every row of each table copied, by table. */
export type CopiedRows = Partial<Record<(typeof COPIED_TABLES)[number], Record<string, unknown>[]>>

export async function copyDatabase(source: Db, target: Db): Promise<Record<string, number>> {
    if ((await one<{n: number}>(target, 'SELECT count(*) AS n FROM projects')).n) throw new Error('The target already has projects: copy into an empty orrery')
    // Read first, all of it in one transaction (on Postgres one snapshot of it), so a write while it copies a
    // running orrery can't leave a row pointing at one that isn't there.
    const rows = await source.transaction(async () => {
        if (source.dialect === 'postgres') await source.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        const read: CopiedRows = {}
        for (const table of COPIED_TABLES) read[table] = await source.all<Record<string, unknown>>(`SELECT * FROM ${table}`)
        return read
    })
    const copied: Record<string, number> = {}
    await target.transaction(async () => {
        await target.deferConstraints()
        // A new database starts with the default statuses and the default workspace, and may have had the presets orrery
        // ships seeded; the source's replace them.
        await target.run('DELETE FROM statuses')
        await target.run('DELETE FROM settings')
        await target.run('DELETE FROM workspace_members')
        await target.run('DELETE FROM workspaces')
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
        if (target.dialect === 'postgres') {
            for (const table of NUMBERED) {
                await target.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`)
            }
        }
    })
    return copied
}
