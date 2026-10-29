// What every part of the store stands on: the database, telling open pages of a change, reading rows and
// records, the owner's protection, and writing.
import type {ActivityField, Asks, Board, Choice, Chunk, DocSummary, Issue, IssueStatus, Notice, Picks, Project, Release, Settings, Signal, Starts} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, notFound} from '../utils/input'
import type {IssueInput} from '../utils/roadmap'
import {buildBoard} from '../utils/roadmap'
import type {Db, Value} from '../utils/database'
import {one} from '../utils/database'
import type {Instruction} from '#shared/prompt'
import type {IssueRecord, ChunkRecord, Actor, ProjectRow, ChunkRow, IssueRow, CommentRow, DocRow, ReleaseRow} from './schema'
import {OPEN_ASK, tallyReleases, releaseOf, noReleases, nullable, stamp, summaryOf, matchOf} from './schema'
import {known} from '#shared/known'
import type {OrreryEvent} from '#shared/happenings'
import {refusedFor} from '../utils/permission'

export abstract class StoreBase {
    constructor(
        /** Changed only when the owner moves the database (`rebindDatabase`). */
        public db: Db,
        protected readonly onChange: (project: string) => void = () => {},
        protected readonly onSignal: (signal: Signal) => void = () => {},
        protected readonly onNotice: (notice: Notice) => void = () => {},
        protected readonly onSettings: (settings: Settings) => void = () => {},
        /** The owner's id until they give their name (what orrery used before it asked). */
        protected readonly unnamed = 'owner',
    ) {}

    /** Whether a session on the project is there to hear a signal now; the server sets it from its sessions. */
    hears: (project: string, session: string) => boolean = () => true

    /** Hears what happens (`issue.status`, `release.frozen`…), for the schedules that run on it; the server sets it. */
    happened: (event: OrreryEvent) => void = () => {}

    /** Says what happened, as `actor` did it. */
    protected tell(type: string, project: string, subject: string, actor: Actor, change: {from?: string | null, to?: string | null} = {}) {
        this.happened({type, project, subject, by: {name: actor.name, owner: actor.owner}, ...actor.untrusted ? {untrusted: true} : {},
            ...change.from == null ? {} : {from: change.from}, ...change.to == null ? {} : {to: change.to}})
    }

    /** Projects changed while a batch runs, said once it ends rather than once per issue. */
    protected held: Set<string> | null = null

    /** Tells the page the project changed (also after a write made outside the store, a schedule marking its
     * issue), and the projects sharing its releases: a source counts the issues of those drawing on it, and they
     * show its releases. */
    changed(project: string) {
        if (this.held) return void this.held.add(project)
        this.onChange(project)
        this.all<{id: string}>('SELECT id FROM projects WHERE releases_from = ? OR id = (SELECT releases_from FROM projects WHERE id = ?)', project, project)
            .then(rows => rows.forEach(r => this.onChange(r.id)), () => {})
    }

    /** The project its releases are: its `releases_from`, its own, or none when it has no releases. */
    protected async releaseSource(project: string): Promise<string | null> {
        const row = await this.projectRow(project)
        return row.release_mode === 'shared' ? row.releases_from : row.release_mode === 'own' ? project : null
    }

    /** The projects taking their releases from `project`, by id. */
    protected async drawingOn(project: string): Promise<string[]> {
        return (await this.all<{id: string}>('SELECT id FROM projects WHERE releases_from = ? ORDER BY id', project)).map(r => r.id)
    }

    protected async orreryStarts(): Promise<Starts | undefined> {
        const row = await this.get<{value: string}>('SELECT value FROM settings WHERE key = ?', 'starts')
        return (row ? JSON.parse(row.value) as Starts | null : null) ?? undefined
    }

    /** The orrery's statuses, in order (`StatusStore` has them). */
    abstract statuses(): Promise<IssueStatus[]>

    // Reading

    protected async projectOf(row: ProjectRow): Promise<Project> {
        const board = await this.board(row.id)
        return {
            id: row.id,
            name: row.name,
            key: row.key,
            description: row.description ?? undefined,
            icon: row.icon ?? undefined,
            icon_color: row.icon_color ?? undefined,
            focus_prompt: row.focus_prompt ?? undefined,
            chunk_prompt: row.chunk_prompt ?? undefined,
            instructions: JSON.parse(row.instructions) as Instruction[],
            muted: JSON.parse(row.muted) as string[],
            starts: await this.orreryStarts(),
            repo: row.repo ?? undefined,
            release_mode: row.release_mode,
            releases_from: row.releases_from ?? undefined,
            created_by: row.created_by,
            protected: !!row.owned,
            created_at: row.created_at,
            updated_at: row.updated_at,
            board,
            docs: await this.docSummaries(row.id),
            releases: await this.releasesOf(row, board),
        }
    }

    /** The project's releases (its source's, when it takes them from another), in the order they're arranged in; each with how far its issues are
     * (see tallyReleases). A source counts the issues of every project drawing on it; one drawing on it counts its own. */
    protected async releasesOf(project: ProjectRow, board: Board): Promise<Release[]> {
        if (project.release_mode === 'none') return []
        const rows = await this.all<ReleaseRow>('SELECT * FROM releases WHERE project = ? ORDER BY position, created_at DESC',
            project.releases_from ?? project.id)
        const boards = project.releases_from ? [board] : [board, ...await Promise.all((await this.drawingOn(project.id)).map(id => this.board(id)))]
        const tally = tallyReleases(rows.map(r => r.version), boards)
        return rows.map(row => ({...releaseOf(row), ...known(tally.get(row.version), `a tally for ${row.version}`)}))
    }

    /** A project's docs without their text, by title, A–Z, sorted here rather than in SQL so SQLite and Postgres agree on
     * case and accents. With `q`, only those with every word of it in their title or text, any order and case: the ones
     * with them all in the title first, each with `match`, the text around its first hit. */
    protected async docSummaries(project: string, q = ''): Promise<DocSummary[]> {
        const words = q.toLowerCase().split(/\s+/).filter(Boolean)
        const inTitle = (row: DocRow) => words.every(word => row.title.toLowerCase().includes(word))
        return (await this.all<DocRow>('SELECT * FROM docs WHERE project = ?', project))
            .filter(row => words.every(word => `${row.title}\n${row.body}`.toLowerCase().includes(word)))
            .sort((a, b) => Number(inTitle(b)) - Number(inTitle(a))
                || a.title.localeCompare(b.title, 'en', {sensitivity: 'base', numeric: true}) || a.id.localeCompare(b.id))
            .map(row => ({
                id: row.id, title: row.title, summary: summaryOf(row.body), ...words.length ? {match: matchOf(row.body, words)} : {},
                created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
            }))
    }

    protected async board(project: string): Promise<Board> {
        const chunks = await this.all<ChunkRow>('SELECT * FROM chunks WHERE project = ? ORDER BY position, created_at', project)
        const issues = await this.all<IssueRow>('SELECT * FROM issues WHERE project = ? ORDER BY position, created_at', project)
        const comments = new Map((await this.all<{issue: string, n: number}>('SELECT issue, count(*) AS n FROM comments WHERE project = ? GROUP BY issue', project))
            .map(r => [r.issue, r.n]))
        // Each issue's latest question from an agent that no comment of the owner's has come after.
        const waiting = new Map((await this.all<{issue: string, asks: Asks}>(`SELECT c.issue, c.asks FROM comments c WHERE c.project = ? AND ${OPEN_ASK} ORDER BY c.id`, project))
            .map(r => [r.issue, r.asks]))
        const aliases = async (table: 'issue_aliases' | 'chunk_aliases', column: 'issue' | 'chunk') => {
            const found = new Map<string, string[]>()
            for (const row of await this.all<{alias: string, of: string}>(`SELECT alias, ${column} AS of FROM ${table} WHERE project = ? ORDER BY alias`, project)) {
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
            waiting: waiting.get(row.id),
            aliases: issueAliases.get(row.id) ?? [],
            schedule: row.schedule ?? undefined,
            release: row.ships_in ?? undefined,
            created_by: row.created_by,
            ...row.session_name ? {session_name: row.session_name} : {},
            protected: !!row.owned,
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
        return buildBoard({chunks: grouped}, await this.statuses())
    }

    protected issueRecords(project: Project): IssueRecord[] {
        const records: IssueRecord[] = []
        const walk = (issues: Issue[], parent: string | null, chunk: string) => {
            for (const {tasks, ...issue} of issues) {
                records.push({...issue, project: project.id, parent, chunk: chunk || null, sub_issues: tasks.map(t => t.id)})
                walk(tasks, issue.id, chunk)
            }
        }
        project.board.chunks.forEach(c => walk(c.tasks, null, c.id))
        return records
    }

    protected findIssue(project: Project, id: string): {issue: Issue, parent: string | null, chunk: string} | null {
        const search = (issues: Issue[], parent: string | null, chunk: string): {issue: Issue, parent: string | null, chunk: string} | null => {
            for (const issue of issues) {
                if (issue.id === id) return {issue, parent, chunk}
                const found = search(issue.tasks, issue.id, chunk)
                if (found) return found
            }
            return null
        }
        for (const chunk of project.board.chunks) {
            const found = search(chunk.tasks, null, chunk.id)
            if (found) return found
        }
        return null
    }

    protected chunkRecord(row: ChunkRow, view: Chunk): ChunkRecord {
        const {tasks, ...chunk} = view
        return {...chunk, project: row.project, position: row.position, created_at: row.created_at, updated_at: row.updated_at, issues: tasks.map(t => t.id)}
    }

    /** The issue's id, from its id or an id it had before (an alias). */
    protected async issueId(project: string, id: string): Promise<string> {
        if (await this.get('SELECT 1 FROM issues WHERE project = ? AND id = ?', project, id)) return id
        return (await this.get<{issue: string}>('SELECT issue FROM issue_aliases WHERE project = ? AND alias = ?', project, id))?.issue ?? id
    }

    /** The chunk's id, from its number or a name it had before (an alias). */
    protected async chunkId(project: string, id: string): Promise<string> {
        if (await this.get('SELECT 1 FROM chunks WHERE project = ? AND id = ?', project, id)) return id
        return (await this.get<{chunk: string}>('SELECT chunk FROM chunk_aliases WHERE project = ? AND alias = ?', project, id))?.chunk ?? id
    }

    /** Hands out the project's next id: KEY-n for an issue, n for a chunk. */
    protected async nextId(project: string, kind: 'issue' | 'chunk'): Promise<string> {
        const {key} = await this.projectRow(project)
        const [column, table, aliases] = kind === 'issue' ? ['next_number', 'issues', 'issue_aliases'] as const : ['next_chunk', 'chunks', 'chunk_aliases'] as const
        const name = (n: number) => kind === 'issue' ? `${key}-${n}` : String(n)
        // Each number is taken in one statement, so two writers never get the same one; one an import
        // already used, or that's still an id something had, is skipped.
        for (;;) {
            const {n} = await this.one<{n: number}>(`UPDATE projects SET ${column} = ${column} + 1 WHERE id = ? RETURNING ${column} - 1 AS n`, project)
            if (!await this.get(`SELECT 1 FROM ${table} WHERE project = ? AND id = ? UNION SELECT 1 FROM ${aliases} WHERE project = ? AND alias = ?`, project, name(n), project, name(n))) return name(n)
        }
    }

    protected async rootOf(project: string, row: IssueRow): Promise<IssueRow> {
        let root = row
        while (root.parent) root = await this.issueRow(project, root.parent)
        return root
    }

    protected async projectRow(id: string): Promise<ProjectRow> {
        const row = await this.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
        if (!row) throw notFound(`No project "${id}"`)
        return row
    }

    protected async chunkRow(project: string, id: string): Promise<ChunkRow> {
        await this.projectRow(project)
        const row = await this.get<ChunkRow>('SELECT * FROM chunks WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No chunk "${id}" in ${project}`)
        return row
    }

    protected async issueRow(project: string, id: string): Promise<IssueRow> {
        await this.projectRow(project)
        const row = await this.get<IssueRow>('SELECT * FROM issues WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No issue ${id} in ${project}`)
        return row
    }

    protected async docRow(project: string, id: string): Promise<DocRow> {
        await this.projectRow(project)
        const row = await this.get<DocRow>('SELECT * FROM docs WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No doc "${id}" in ${project}`)
        return row
    }

    /** The release by its version, in the project's source when it takes its releases from another. */
    protected async releaseRow(project: string, version: string): Promise<ReleaseRow> {
        const source = await this.releaseSource(project)
        if (!source) throw badRequest(noReleases(project))
        const row = await this.get<ReleaseRow>('SELECT * FROM releases WHERE project = ? AND version = ?', source, version)
        if (!row) throw notFound(`No release ${version} in ${source}${source === project ? '' : ` (where ${project} takes its releases from)`}; make it with POST /api/projects/${source}/releases`)
        return row
    }

    protected async commentRow(project: string, issue: string, id: number): Promise<CommentRow> {
        await this.issueRow(project, issue)
        const row = await this.get<CommentRow>('SELECT * FROM comments WHERE project = ? AND issue = ? AND id = ?', project, issue, id)
        if (!row) throw notFound(`No comment ${id} on ${issue}`)
        return row
    }

    // Protection

    /** Refuses an agent `action` when it would take away what the owner made. */
    protected refuse(actor: Actor, action: string, owned: string[]) {
        if (actor.owner || !owned.length) return
        const shown = owned.length > 4 ? [...owned.slice(0, 3), `${owned.length - 3} more`] : owned
        throw refusedFor('issues.delete', `${action} is the owner's call: ${shown.join(', ')} ${owned.length === 1 ? 'was' : 'were'} made by the owner`)
    }

    /** What the owner made in the project, the project included. */
    protected async ownedIn(project: string): Promise<string[]> {
        const row = await this.projectRow(project)
        return [
            ...row.owned ? [`project "${project}"`] : [],
            ...(await this.all<{id: string}>('SELECT id FROM chunks WHERE project = ? AND owned = 1', project)).map(c => `chunk "${c.id}"`),
            ...(await this.all<{id: string}>('SELECT id FROM docs WHERE project = ? AND owned = 1', project)).map(d => `doc "${d.id}"`),
            ...(await this.all<{version: string}>('SELECT version FROM releases WHERE project = ? AND owned = 1', project)).map(r => `release ${r.version}`),
            ...await this.ownedUnder(project, (await this.all<{id: string}>('SELECT id FROM issues WHERE project = ?', project)).map(i => i.id)),
        ]
    }

    /** The owner's issues and comments among these issues. */
    protected async ownedUnder(project: string, issues: string[]): Promise<string[]> {
        if (!issues.length) return []
        const marks = issues.map(() => '?').join(', ')
        return [
            ...(await this.all<{id: string}>(`SELECT id FROM issues WHERE project = ? AND owned = 1 AND id IN (${marks})`, project, ...issues)).map(i => i.id),
            ...(await this.all<{id: number, issue: string}>(`SELECT id, issue FROM comments WHERE project = ? AND owned = 1 AND issue IN (${marks})`, project, ...issues))
                .map(c => `comment ${c.id} on ${c.issue}`),
        ]
    }

    // Writing

    /** Notes the fields that change: `after` undefined is left as it is, and a value equal to `before` is no
     * change. `created` is always noted. Notes keep no values, only that they changed. */
    protected async record(project: string, issue: string, actor: Actor, changes: [ActivityField, string | null, Input[string]][]) {
        const now = stamp()
        for (const [field, before, after] of changes) {
            if (field !== 'created' && (after === undefined || (after ?? null) === before)) continue
            const [from, to] = field === 'notes' ? [null, null] : [before, nullable(after)]
            await this.run('INSERT INTO issue_events (project, issue, field, before, after, created_by, session_name, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, issue, field, from, to, actor.name, actor.session ?? null, Number(actor.owner), now)
            // Text an outsider may have written (a title, its links) isn't passed on: the issue's id is, to read.
            this.tell(`issue.${field}`, project, issue, actor, field === 'title' || field === 'external' ? {} : {from, to})
        }
    }

    /** Sets the given fields (undefined ones are left as they are) and the update time. */
    protected async update(table: string, where: string, keys: Value[], fields: Input) {
        const set = Object.entries(fields).filter(([, value]) => value !== undefined)
        const columns = [...set.map(([column]) => `${column} = ?`), 'updated_at = ?']
        await this.run(`UPDATE ${table} SET ${columns.join(', ')} WHERE ${where}`, ...set.map(([, value]) => value as Value), stamp(), ...keys)
    }

    protected async touchProject(project: string) {
        await this.run('UPDATE projects SET updated_at = ? WHERE id = ?', stamp(), project)
    }

    protected async touchIssue(project: string, issue: string) {
        const now = stamp()
        await this.run('UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?', now, project, issue)
        await this.run('UPDATE projects SET updated_at = ? WHERE id = ?', now, project)
    }

    protected async nextPosition(table: 'chunks' | 'issues' | 'docs', project: string): Promise<number> {
        return ((await this.get<{n: number | null}>(`SELECT max(position) AS n FROM ${table} WHERE project = ?`, project))?.n ?? -1) + 1
    }

    protected run(sql: string, ...params: Value[]) {
        return this.db.run(sql, ...params)
    }

    protected get<T>(sql: string, ...params: Value[]) {
        return this.db.get<T>(sql, ...params)
    }

    protected one<T>(sql: string, ...params: Value[]) {
        return one<T>(this.db, sql, ...params)
    }

    protected all<T>(sql: string, ...params: Value[]) {
        return this.db.all<T>(sql, ...params)
    }
}
