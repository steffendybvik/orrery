// One board as one file (ORR-668): a snapshot of a project, read in one transaction, that leaves the board where it is.
// Every table the whole orrery's copy takes (`COPIED_TABLES`) is classed here as exported or not, and test/board-export.test.ts
// fails on one that isn't, so a new table can't be left out by accident. Secrets never travel in a file, and live state
// (sessions, signals, the pull request cache) stays behind. What points outside the board (a dependency on another
// project's issue, releases taken from another project) stays as the plain reference its row holds.
import type {Db} from './database'
import type {COPIED_TABLES} from './copy'
import {MIGRATIONS} from './migrations/sqlite'

type Table = (typeof COPIED_TABLES)[number]
type Row = Record<string, unknown>

const OF_PROJECT = 'project = ?'
const OF_COMMENTS = 'comment IN (SELECT id FROM comments WHERE project = ?)'
const OF_SCHEDULES = 'schedule IN (SELECT id FROM schedules WHERE project = ?)'

/** What's exported of each table: which rows, by the project's id. */
export const EXPORTED = {
    projects: 'id = ?',
    project_members: OF_PROJECT,
    releases: OF_PROJECT,
    chunks: OF_PROJECT,
    chunk_aliases: OF_PROJECT,
    issues: OF_PROJECT,
    issue_aliases: OF_PROJECT,
    issue_links: OF_PROJECT,
    issue_events: OF_PROJECT,
    comments: OF_PROJECT,
    schedule_requests: OF_COMMENTS,
    docs: OF_PROJECT,
    doc_sections: OF_PROJECT,
    doc_revisions: OF_PROJECT,
    schedules: OF_PROJECT,
    schedule_runs: OF_SCHEDULES,
    presets: OF_PROJECT,
} as const satisfies Partial<Record<Table, string>>

/** What isn't, and why. `uploads`, `people` and `statuses` go in on their own, only what the board uses. */
export const NOT_EXPORTED = {
    secrets: 'never travel in a file',
    secret_uses: 'what secrets did, on this server',
    keys: 'credentials',
    logins: 'credentials',
    identities: 'credentials',
    invites: 'credentials',
    settings: "the server's, not a board's",
    preset_defaults: "the server's, not a board's",
    schedules_across: "the server's, not a board's: each project's copy goes with its schedules",
    events: "the server's log",
    signals: 'live state',
    issue_sessions: 'live state',
    session_people: 'live state',
    schedule_held: 'live state',
    notice_clears: "each person's bell on this server",
    notice_reads: "each person's bell on this server",
    proposal_clears: "the owner's bell on this server",
    issue_pulls: 'read again from GitHub where the board lands',
    pull_states: 'the pull request cache',
    pull_repos: 'the pull request cache',
} as const satisfies Partial<Record<Table, string>>

/** Taken as the board uses them, below. */
export const USED_ONLY = ['uploads', 'people', 'statuses'] as const satisfies readonly Table[]

const UPLOAD = /\/api\/uploads\/([0-9a-f]{24})/g

export interface BoardExport {
    format: 'orrery-board'
    format_version: 1
    /** The schema step it was read at, for an upload to know what it holds. */
    schema_step: number
    exported_at: string
    project: string
    /** Those the board names, as ids and names, for an upload to match: members, assignees and claims. */
    people: {id: string, name: string}[]
    /** The statuses its issues are in, for an upload to map to its own. */
    statuses: Row[]
    /** The images its text shows, each `data` in base64. */
    uploads: Row[]
    tables: Record<keyof typeof EXPORTED, Row[]>
}

/** The board `project` as one file's contents. */
export async function exportBoard(db: Db, project: string): Promise<BoardExport> {
    return await db.transaction(async () => {
        if (db.dialect === 'postgres') await db.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        const tables = {} as BoardExport['tables']
        for (const [table, which] of Object.entries(EXPORTED) as [keyof typeof EXPORTED, string][]) {
            tables[table] = await db.all<Row>(`SELECT * FROM ${table} WHERE ${which}`, project)
        }
        const named = new Set([...tables.project_members.map(row => row.person), ...tables.issues.flatMap(row => [row.assignee, row.claimed_by, row.created_person])]
            .filter((id): id is string => typeof id === 'string').map(id => id.toLowerCase()))
        const people = (await db.all<{id: string, name: string}>('SELECT id, name FROM people ORDER BY id')).filter(person => named.has(person.id))
        const used = new Set(tables.issues.map(row => row.status))
        const statuses = (await db.all<Row>('SELECT * FROM statuses ORDER BY position')).filter(status => used.has(status.id))
        const shown = [...new Set([...JSON.stringify(tables).matchAll(UPLOAD)].map(match => match[1] as string))]
        const uploads = shown.length ? await db.all<Row & {data: Uint8Array}>(`SELECT * FROM uploads WHERE id IN (${shown.map(() => '?').join(', ')}) ORDER BY id`, ...shown) : []
        return {
            format: 'orrery-board', format_version: 1, schema_step: MIGRATIONS.length, exported_at: new Date().toISOString(), project, people, statuses,
            uploads: uploads.map(upload => ({...upload, data: Buffer.from(upload.data).toString('base64')})), tables,
        }
    })
}
