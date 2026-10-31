// The store's reads that need nothing but the database: a project's board, its releases with how far their issues are,
// its docs without their text, and the board's issues as records (ORR-501). StoreBase builds a project from them.
import type {Asks, Board, Choice, Chunk, DocSummary, Issue, IssueStatus, Picks, Release} from '#shared/roadmap'
import {CLOSED, linkRef} from '#shared/roadmap'
import type {IssueInput} from '../utils/roadmap'
import {buildBoard} from '../utils/roadmap'
import type {Db} from '../utils/database'
import type {IssueRecord, ChunkRecord, ProjectRow, ChunkRow, IssueRow, DocRow, ReleaseRow} from './schema'
import {OPEN_ASK, tallyReleases, releaseOf, docSummaryOf, matchOf} from './schema'
import {known} from '#shared/known'

/** The projects taking their releases from `project`, by id. */
export async function drawingOn(db: Db, project: string): Promise<string[]> {
    return (await db.all<{id: string}>('SELECT id FROM projects WHERE releases_from = ? ORDER BY id', project)).map(r => r.id)
}

/** The project's issues that are done (ORR-601), by their own status, a parent's too whatever its sub-issues', and
 * not while it's a proposal: what no longer holds back an issue that depends on it. A canceled one still does, until
 * the owner drops the link or cancels what waits on it. */
export async function doneIssues(db: Db, project: string, statuses: IssueStatus[]): Promise<Set<string>> {
    const done = new Set(statuses.filter(s => s.kind === 'done').map(s => s.id))
    const rows = await db.all<{id: string, status: string, proposal: string | null}>('SELECT id, status, proposal FROM issues WHERE project = ?', project)
    return new Set(rows.filter(r => !r.proposal && done.has(r.status)).map(r => r.id))
}

/** The project's dependency links (ORR-601), each way: what each of its issues depends on (and which of those are
 * not done yet), and what depends on each, as `linkRef`s from the project. */
async function readLinks(db: Db, project: string, statuses: IssueStatus[]) {
    const on = await db.all<{issue: string, on_project: string, on_issue: string}>('SELECT issue, on_project, on_issue FROM issue_links WHERE project = ? ORDER BY created_at, on_project, on_issue', project)
    const by = await db.all<{project: string, issue: string, on_issue: string}>('SELECT project, issue, on_issue FROM issue_links WHERE on_project = ? ORDER BY created_at, project, issue', project)
    const done = new Map<string, Set<string>>()
    for (const other of new Set(on.map(l => l.on_project))) done.set(other, await doneIssues(db, other, statuses))
    const dependsOn = new Map<string, string[]>()
    const blockedBy = new Map<string, string[]>()
    const blocks = new Map<string, string[]>()
    for (const link of on) {
        const ref = linkRef(project, link.on_project, link.on_issue)
        dependsOn.set(link.issue, [...dependsOn.get(link.issue) ?? [], ref])
        if (!done.get(link.on_project)?.has(link.on_issue)) blockedBy.set(link.issue, [...blockedBy.get(link.issue) ?? [], ref])
    }
    for (const link of by) blocks.set(link.on_issue, [...blocks.get(link.on_issue) ?? [], linkRef(project, link.project, link.issue)])
    return {dependsOn, blockedBy, blocks}
}

/** The project's board: its chunks and their issues, sub-issues within, each with its comment count, open question,
 * the ids it had before and its dependency links. */
export async function readBoard(db: Db, project: string, statuses: IssueStatus[]): Promise<Board> {
    const chunks = await db.all<ChunkRow>('SELECT * FROM chunks WHERE project = ? ORDER BY position, created_at', project)
    const issues = await db.all<IssueRow>('SELECT * FROM issues WHERE project = ? ORDER BY position, created_at', project)
    const comments = new Map((await db.all<{issue: string, n: number}>('SELECT issue, count(*) AS n FROM comments WHERE project = ? GROUP BY issue', project))
        .map(r => [r.issue, r.n]))
    // Each issue's latest question from an agent that no comment of the owner's has come after.
    const waiting = new Map((await db.all<{issue: string, asks: Asks}>(`SELECT c.issue, c.asks FROM comments c WHERE c.project = ? AND ${OPEN_ASK} ORDER BY c.id`, project))
        .map(r => [r.issue, r.asks]))
    const aliases = async (table: 'issue_aliases' | 'chunk_aliases', column: 'issue' | 'chunk') => {
        const found = new Map<string, string[]>()
        for (const row of await db.all<{alias: string, of: string}>(`SELECT alias, ${column} AS of FROM ${table} WHERE project = ? ORDER BY alias`, project)) {
            found.set(row.of, [...found.get(row.of) ?? [], row.alias])
        }
        return found
    }
    // An agent's proposal waiting on the owner (pending, not under another proposal, as the bell has it) waits on
    // their decision too, when no question of its own is open.
    const proposals = new Set(issues.filter(row => row.proposal).map(row => row.id))
    for (const row of issues) {
        if (row.proposal === 'pending' && !row.owned && !(row.parent && proposals.has(row.parent)) && !waiting.has(row.id)) waiting.set(row.id, 'decision')
    }
    // One that's done or canceled waits on nobody, whatever was left unanswered on it (ORR-640).
    const closed = new Set(statuses.filter(s => CLOSED.includes(s.kind)).map(s => s.id))
    const links = await readLinks(db, project, statuses)
    const issueAliases = await aliases('issue_aliases', 'issue')
    const chunkAliases = await aliases('chunk_aliases', 'chunk')
    const children = new Map<string | null, IssueRow[]>()
    for (const row of issues) children.set(row.parent, [...children.get(row.parent) ?? [], row])

    const input = (row: IssueRow): IssueInput => ({
        id: row.id,
        title: row.title,
        priority: row.priority ?? undefined,
        assignee: row.assignee ?? undefined,
        labels: JSON.parse(row.labels) as string[],
        external: JSON.parse(row.external) as string[],
        github_issues: JSON.parse(row.github_issues) as string[],
        status: row.status,
        notes: row.notes ?? undefined,
        proposal: row.proposal ?? undefined,
        decided_by: row.decided_by ?? undefined,
        decided_at: row.decided_at ?? undefined,
        decision_note: row.decision_note ?? undefined,
        choices: JSON.parse(row.choices) as Choice[],
        picks: row.picks ? JSON.parse(row.picks) as Picks : undefined,
        explore: row.explore ? JSON.parse(row.explore) as {choice: string, option: string} : undefined,
        comments: comments.get(row.id) ?? 0,
        waiting: closed.has(row.status) ? undefined : waiting.get(row.id),
        aliases: issueAliases.get(row.id) ?? [],
        schedule: row.schedule ?? undefined,
        release: row.ships_in ?? undefined,
        created_by: row.created_by,
        ...row.session_name ? {session_name: row.session_name} : {},
        ...row.claimed_by ? {claimed_by: row.claimed_by, ...row.claimed_at ? {claimed_at: row.claimed_at} : {}} : {},
        protected: !!row.owned,
        ...links.dependsOn.has(row.id) ? {depends_on: links.dependsOn.get(row.id)} : {},
        ...links.blockedBy.has(row.id) ? {blocked_by: links.blockedBy.get(row.id)} : {},
        ...links.blocks.has(row.id) ? {blocks: links.blocks.get(row.id)} : {},
        created_at: row.created_at,
        updated_at: row.updated_at,
        tasks: (children.get(row.id) ?? []).map(input),
    })
    const top = children.get(null) ?? []
    const grouped = chunks.map(c => ({
        id: c.id, title: c.title, summary: c.summary ?? '', priority: c.priority ?? undefined, aliases: chunkAliases.get(c.id) ?? [], created_by: c.created_by, protected: !!c.owned,
        tasks: top.filter(t => t.chunk === c.id).map(input),
    }))
    const loose = top.filter(t => !t.chunk)
    if (loose.length) grouped.push({id: '', title: 'No chunk', summary: '', priority: undefined, aliases: [], created_by: '', protected: false, tasks: loose.map(input)})
    return buildBoard({chunks: grouped}, statuses)
}


/** The project's issues as far as tallying its releases takes (`tallyReleases`), all in one chunk: no comments, links,
 * aliases or notes, so `GET /api/releases` doesn't build every project's board (ORR-671). */
export async function readReleaseBoard(db: Db, project: string, statuses: IssueStatus[]): Promise<Board> {
    const rows = await db.all<Pick<IssueRow, 'id' | 'parent' | 'status' | 'proposal' | 'ships_in'>>('SELECT id, parent, status, proposal, ships_in FROM issues WHERE project = ?', project)
    const children = new Map<string | null, typeof rows>()
    for (const row of rows) children.set(row.parent, [...children.get(row.parent) ?? [], row])
    const input = (row: typeof rows[number]): IssueInput => ({
        id: row.id, title: '', labels: [], status: row.status, proposal: row.proposal ?? undefined, release: row.ships_in ?? undefined,
        tasks: (children.get(row.id) ?? []).map(input),
    })
    return buildBoard({chunks: [{id: '', title: '', summary: '', tasks: (children.get(null) ?? []).map(input)}]}, statuses)
}

/** The project's releases (its source's, when it takes them from another), in the order they're arranged in; each with how far its issues are
 * (see tallyReleases). A source counts the issues of every project drawing on it; one drawing on it counts its own. */
export async function readReleases(db: Db, project: ProjectRow, board: Board, statuses: IssueStatus[]): Promise<Release[]> {
    if (project.release_mode === 'none') return []
    const rows = await db.all<ReleaseRow>('SELECT * FROM releases WHERE project = ? ORDER BY position, created_at DESC',
        project.releases_from ?? project.id)
    const boards = project.releases_from ? [board] : [board, ...await Promise.all((await drawingOn(db, project.id)).map(id => readBoard(db, id, statuses)))]
    const tally = tallyReleases(rows.map(r => r.version), boards)
    return rows.map(row => ({...releaseOf(row), ...known(tally.get(row.version), `a tally for ${row.version}`)}))
}

/** A project's docs without their text, by title, A–Z, sorted here rather than in SQL so SQLite and Postgres agree on
 * case and accents. With `q`, only those with every word of it in their title or text, any order and case: the ones
 * with them all in the title first, each with `match`, the text around its first hit. */
export async function readDocSummaries(db: Db, project: string, q = ''): Promise<DocSummary[]> {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const inTitle = (row: DocRow) => words.every(word => row.title.toLowerCase().includes(word))
    return (await db.all<DocRow>('SELECT * FROM docs WHERE project = ?', project))
        .filter(row => words.every(word => `${row.title}\n${row.body}`.toLowerCase().includes(word)))
        .sort((a, b) => Number(inTitle(b)) - Number(inTitle(a))
            || a.title.localeCompare(b.title, 'en', {sensitivity: 'base', numeric: true}) || a.id.localeCompare(b.id))
        .map(row => ({
            id: row.id, title: row.title, kind: row.kind, summary: docSummaryOf(row), ...words.length ? {match: matchOf(row.body, words)} : {},
            ...row.section ? {section: row.section} : {},
            created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
        }))
}

/** A project's doc sections, the ones made on their own (empty ones too) and every one a doc is filed under: as arranged, then the rest A–Z (ORR-767). */
export async function readDocSections(db: Db, project: string): Promise<string[]> {
    const names = new Set([
        ...(await db.all<{name: string}>('SELECT name FROM doc_sections WHERE project = ?', project)).map(row => row.name),
        ...(await db.all<{section: string}>('SELECT DISTINCT section FROM docs WHERE project = ? AND section IS NOT NULL', project)).map(row => row.section),
    ])
    const row = await db.get<{doc_section_order: string}>('SELECT doc_section_order FROM projects WHERE id = ?', project)
    const arranged = (JSON.parse(row?.doc_section_order ?? '[]') as string[]).filter(name => names.has(name))
    const rest = [...names].filter(name => !arranged.includes(name)).sort((a, b) => a.localeCompare(b, 'en', {sensitivity: 'base', numeric: true}))
    return [...arranged, ...rest]
}

/** The board's issues as records, each with its parent and chunk, in board order. */
export function issueRecords(project: string, board: Board): IssueRecord[] {
    const records: IssueRecord[] = []
    const walk = (issues: Issue[], parent: string | null, chunk: string) => {
        for (const {tasks, ...issue} of issues) {
            records.push({...issue, project, parent, chunk: chunk || null, sub_issues: tasks.map(t => t.id)})
            walk(tasks, issue.id, chunk)
        }
    }
    board.chunks.forEach(c => walk(c.tasks, null, c.id))
    return records
}

/** The issue on the board, with its parent and chunk; null when it isn't there. */
export function findIssue(board: Board, id: string): {issue: Issue, parent: string | null, chunk: string} | null {
    const search = (issues: Issue[], parent: string | null, chunk: string): {issue: Issue, parent: string | null, chunk: string} | null => {
        for (const issue of issues) {
            if (issue.id === id) return {issue, parent, chunk}
            const found = search(issue.tasks, issue.id, chunk)
            if (found) return found
        }
        return null
    }
    for (const chunk of board.chunks) {
        const found = search(chunk.tasks, null, chunk.id)
        if (found) return found
    }
    return null
}

/** A chunk as it's handed out: its row's place and times, and its issues by id. */
export function chunkRecord(row: ChunkRow, view: Chunk): ChunkRecord {
    const {tasks, ...chunk} = view
    return {...chunk, project: row.project, position: row.position, created_at: row.created_at, updated_at: row.updated_at, issues: tasks.map(t => t.id)}
}
