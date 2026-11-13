// What every part of the store stands on: the database, telling open pages of a change, reading rows and
// records, the owner's protection, and writing.
import {AsyncLocalStorage} from 'node:async_hooks'
import type {ActivityField, Board, IssueStatus, Notice, Project, Settings, Signal, Starts} from '#shared/roadmap'
import {numberOf, shortId} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, notFound} from '../utils/input'
import type {Db, Value} from '../utils/database'
import {one} from '../utils/database'
import type {Instruction} from '#shared/prompt'
import type {Actor, ProjectRow, MilestoneRow, IssueRow, CommentRow, DocRow, ReleaseRow} from './schema'
import {ANSWERED, noReleases, nullable, stamp} from './schema'
import type {OrreryEvent} from '#shared/happenings'
import {refusedFor} from '../utils/permission'
import {drawingOn, readBoard, readDocSections, readDocSummaries, readReleases} from './reads'

/** Set while the router tells what a write the Rust API made set off: the API put it in the outbox already (ORR-929). */
const relayed = new AsyncLocalStorage<true>()

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

    /** Whose a session is, as its stream said; the server sets it from its sessions. */
    sessionPerson: (session: string) => string | undefined = () => undefined

    /** See people.ts. */
    abstract whoseWork(project: string, assignee: string | null | undefined): Promise<string | null | undefined>

    /** Hears what happens (`issue.status`, `release.frozen`…), for the schedules that run on it; the server sets it. */
    happened: (event: OrreryEvent) => void = () => {}

    /** The schedule whose run the code running now is part of, if any; the server sets it. */
    cause: () => string | undefined = () => undefined

    /** A read asked of the Rust API when it's set up (ORR-1162): its reply, or undefined with no API, which leaves the
     * read to the database here. It answers alike (a 404 where the store would throw one). Imported when used, as the
     * router reads the store. */
    protected async fromApi<T>(path: string): Promise<T | undefined> {
        const {readFromApi} = await import('../utils/api-router')
        return await readFromApi<T>(path)
    }

    /** Tells what a write the Rust API made set off (`work`, the router's hooks), without a second row in the outbox. */
    async relaying<T>(work: () => Promise<T>): Promise<T> {
        return await relayed.run(true, work)
    }

    /** A row in the outbox (ORR-929) for what a write set off, as the Rust API writes for its own: in the write's
     * transaction when there is one, else at once. A project's change, the settings or the epics go in once a transaction. */
    protected outbox(kind: string, at: {project?: string, subject?: string, actor?: Actor, payload?: unknown} = {}) {
        if (relayed.getStore()) return
        const {project = null, subject = null, actor, payload} = at
        const cause = this.cause() ?? null
        const once = kind === 'project.changed' || kind === 'settings' || kind === 'epics' ? `${kind} ${project ?? ''}` : undefined
        this.db.beforeCommit(async () => {
            const row = await this.db.get<{id: number | string}>('INSERT INTO changes (kind, project, subject, actor, owner, session, untrusted, cause, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
                kind, project, subject, actor?.name ?? null, actor?.owner ? 1 : 0, actor?.session ?? null, actor?.untrusted ? 1 : 0, cause,
                payload === undefined ? null : JSON.stringify(payload), stamp())
            if (row) this.own?.add(Number(row.id))
        }, once)
    }

    /** The outbox rows this server wrote, kept only while it follows the feed (ORR-983): its own hooks heard those. */
    private own: Set<number> | null = null

    /** From now on, keeps the ids of the outbox rows this server writes, for the follower to skip (ORR-983), starting
     * afresh: the ids kept from a database before a move mean other rows on this one (ORR-1035). */
    keepOwnChanges() {
        this.own = new Set()
    }

    /** Whether this server wrote the outbox row `id`, forgetting it: each is read once. */
    wroteChange(id: number): boolean {
        return this.own?.delete(id) ?? false
    }

    /** Open pages get the settings, and the outbox says they changed. */
    protected saySettings(settings: Settings, actor?: Actor) {
        this.outbox('settings', {actor})
        this.onSettings(settings)
    }

    /** Says what happened, as `actor` did it. */
    protected tell(type: string, project: string, subject: string, actor: Actor, change: {from?: string | null, to?: string | null} = {}) {
        const event: OrreryEvent = {type, project, subject, by: {name: actor.name, owner: actor.owner, ...actor.person && !actor.owner ? {person: actor.person} : {}}, ...actor.untrusted ? {untrusted: true} : {},
            ...change.from == null ? {} : {from: change.from}, ...change.to == null ? {} : {to: change.to}}
        // Where a value went, and whose agent did it: what a schedule's `on` matches beyond the kind (ORR-929).
        const payload = {...event.from === undefined ? {} : {from: event.from}, ...event.to === undefined ? {} : {to: event.to}, ...event.by?.person ? {person: event.by.person} : {}}
        this.outbox(type, {project, subject, actor, ...Object.keys(payload).length ? {payload} : {}})
        this.happened(event)
    }

    /** A signal for sessions, and its row in the outbox: its id, as the `signals` table holds the rest (ORR-929). */
    protected signalled(signal: Signal) {
        this.outbox('signal', {project: signal.project, subject: String(signal.id)})
        this.onSignal(signal)
    }

    /** An agent's comment for the owner's bell, and its row in the outbox: the comment's id, and its issue (ORR-929). */
    protected noticed(notice: Notice) {
        this.outbox('notice', {project: notice.project, subject: String(notice.id), payload: {issue: notice.issue}})
        this.onNotice(notice)
    }

    /** Says what a write made elsewhere did (the Rust API's, ORR-922), as `tell` does for the store's own. */
    told(type: string, project: string, subject: string, actor: Actor, change: {from?: string | null, to?: string | null} = {}) {
        this.tell(type, project, subject, actor, change)
    }

    /** Projects changed while a batch runs, said once it ends rather than once per issue. */
    protected held: Set<string> | null = null

    /** Tells the page the project changed (also after a write made outside the store, a schedule marking its
     * issue), and the projects sharing its releases: a source counts the issues of those drawing on it, and they
     * show its releases. */
    changed(project: string) {
        this.outbox('project.changed', {project})
        if (this.held) return void this.held.add(project)
        // Inside a write's transaction, open pages hear it the moment it commits, and never when it's taken back.
        this.db.atCommit(() => this.pushChanged(project))
    }

    /** Tells open pages the project changed, and the projects sharing its releases. */
    private pushChanged(project: string) {
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
        return await drawingOn(this.db, project)
    }

    protected async orreryStarts(): Promise<Starts | undefined> {
        const row = await this.get<{value: string}>('SELECT value FROM settings WHERE key = ?', 'starts')
        return (row ? JSON.parse(row.value) as Starts | null : null) ?? undefined
    }

    /** The orrery's statuses, in order (`StatusStore` has them). */
    abstract statuses(): Promise<IssueStatus[]>

    // Reading

    protected async projectOf(row: ProjectRow): Promise<Project> {
        const statuses = await this.statuses()
        const board = await readBoard(this.db, row.id, statuses)
        return {
            id: row.id,
            name: row.name,
            key: row.key,
            uid: row.uid,
            description: row.description ?? undefined,
            icon: row.icon ?? undefined,
            icon_color: row.icon_color ?? undefined,
            focus_prompt: row.focus_prompt ?? undefined,
            milestone_prompt: row.milestone_prompt ?? undefined,
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
            docs: await readDocSummaries(this.db, row.id),
            doc_sections: await readDocSections(this.db, row.id),
            releases: await readReleases(this.db, row, board, statuses),
        }
    }

    /** The project's board alone, without its docs and releases: what reading its issues takes. Refuses a project
     * there isn't. */
    protected async boardOf(project: string): Promise<Board> {
        await this.projectRow(project)
        return await readBoard(this.db, project, await this.statuses())
    }

    /** The issue's id, from its id, an id it had before (an alias), or the full form of either on this board. */
    protected async issueId(project: string, id: string): Promise<string> {
        if (await this.get('SELECT 1 FROM issues WHERE project = ? AND id = ?', project, id)) return id
        const alias = (await this.get<{issue: string}>('SELECT issue FROM issue_aliases WHERE project = ? AND alias = ?', project, id))?.issue
        if (alias) return alias
        const short = shortId('issue', id, (await this.projectRow(project)).uid)
        return short === null ? id : await this.issueId(project, short)
    }

    /** The milestone's id, from its number, a name it had before (an alias), or the full form of either on this board. */
    protected async milestoneId(project: string, id: string): Promise<string> {
        if (await this.get('SELECT 1 FROM milestones WHERE project = ? AND id = ?', project, id)) return id
        const alias = (await this.get<{milestone: string}>('SELECT milestone FROM milestone_aliases WHERE project = ? AND alias = ?', project, id))?.milestone
        if (alias) return alias
        const {uid} = await this.projectRow(project)
        // `MLS-14` as it's shown (ORR-995), `MLS-14-x7k2m9qd` in full, or the full form of a name it had before.
        const short = numberOf('milestone', id, uid) ?? shortId('milestone', id, uid)
        return short === null || short === id ? id : await this.milestoneId(project, short)
    }

    /** Hands out the project's next id: KEY-n for an issue, n for a milestone. */
    protected async nextId(project: string, kind: 'issue' | 'milestone'): Promise<string> {
        const {key} = await this.projectRow(project)
        const [column, table, aliases] = kind === 'issue' ? ['next_number', 'issues', 'issue_aliases'] as const : ['next_milestone', 'milestones', 'milestone_aliases'] as const
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

    protected async milestoneRow(project: string, id: string): Promise<MilestoneRow> {
        await this.projectRow(project)
        const row = await this.get<MilestoneRow>('SELECT * FROM milestones WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No milestone "${id}" in ${project}`)
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

    /** The comment, with whether the owner has answered it since (`answered` isn't stored: it's worked out, ORR-942). */
    protected async commentRow(project: string, issue: string, id: number): Promise<CommentRow> {
        await this.issueRow(project, issue)
        const row = await this.get<CommentRow>(`SELECT c.*, ${ANSWERED} FROM comments c WHERE c.project = ? AND c.issue = ? AND c.id = ?`, project, issue, id)
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
            ...(await this.all<{id: string}>('SELECT id FROM milestones WHERE project = ? AND owned = 1', project)).map(c => `milestone "${c.id}"`),
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
            this.tell(`issue.${field}`, project, issue, actor, field === 'title' || field === 'external' || field === 'github_issues' ? {} : {from, to})
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

    protected async nextPosition(table: 'milestones' | 'issues' | 'docs', project: string): Promise<number> {
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
