// Projects, chunks, issues and comments: reading and changing them, with the rules Linear keeps.
// Issues nest (a parent holds sub-issues, to any depth); only a top-level issue is in a chunk, its
// sub-issues are in the same one. Every change ends with `onChange(project)`, which the server
// turns into a server-sent event, so open pages update.
import type {DatabaseSync, SQLInputValue} from 'node:sqlite'
import type {Board, Chunk, Comment, Counts, Doc, DocSummary, Issue, Notice, Plan, Priority, Project, Signal, Status} from '#shared/roadmap'
import {PLANS, PRIORITIES, STATUSES} from '#shared/roadmap'
import type {Field, Input} from './input'
import {badRequest, checkInput, conflict, forbidden, notFound} from './input'
import type {IssueInput, RoadmapFile, TaskFile} from './roadmap'
import {buildBoard} from './roadmap'
import {transaction} from './db'
import {renumber} from './renumber'

/** A project without its board, as `GET /api/projects` lists it. */
export interface ProjectSummary extends Omit<Project, 'board'> {
    counts: Counts
    chunks: number
}

/** An issue on its own: where it sits, and its sub-issues by id. */
export interface IssueRecord extends Omit<Issue, 'tasks'> {
    project: string
    parent: string | null
    /** The chunk it's in, a sub-issue's being its top-level issue's. */
    chunk: string | null
    subIssues: string[]
}

/** An issue with its sub-issues drawn out, as `GET …/issues/:issue` shows it. */
export interface IssueDetail extends Issue {
    project: string
    parent: string | null
    chunk: string | null
}

export interface ChunkRecord extends Omit<Chunk, 'tasks'> {
    project: string
    position: number
    createdAt: string
    updatedAt: string
    /** Its top-level issues, by id. */
    issues: string[]
}

/** Who's asking, by the name it gives; `owner` when that's the owner's name. */
export interface Actor {
    name: string
    owner: boolean
}

export const AGENT: Actor = {name: 'agent', owner: false}

export interface IssueFilter {
    status?: string
    plan?: string
    priority?: string
    column?: string
    /** A name, or `none` for unassigned issues. */
    assignee?: string
    label?: string
    chunk?: string
    /** An issue id, or `none` for top-level issues. */
    parent?: string
    /** Text in the id or title. */
    q?: string
}

interface Made { created_by: string, owned: number, created_at: string, updated_at: string }
interface ProjectRow extends Made { id: string, name: string, key: string, description: string | null, next_number: number, next_chunk: number }
interface ChunkRow extends Made { project: string, id: string, title: string, summary: string | null, priority: Priority | null, position: number }
interface IssueRow extends Made {
    project: string, id: string, title: string, status: Status, plan: Plan | null, priority: Priority | null,
    assignee: string | null, labels: string, notes: string | null,
    parent: string | null, chunk: string | null, position: number
}
interface CommentRow extends Made { id: number, project: string, issue: string, body: string }
interface DocRow extends Made { project: string, id: string, title: string, body: string, position: number }
interface SignalRow { id: number, project: string, issue: string | null, chunk: string | null, kind: 'focus' | 'comment', note: string | null, target: string | null, delivered_to: string, created_by: string, owned: number, created_at: string }

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const KEY = /^[A-Z][A-Z0-9]{0,9}$/

export const PROJECT_FIELDS: Record<string, Field> = {
    id: {type: 'string', pattern: SLUG, hint: 'use lowercase letters, digits and dashes'},
    name: {type: 'string', required: true},
    key: {type: 'string', pattern: KEY, hint: 'use capitals and digits, starting with a capital, e.g. MSH'},
    description: {type: 'string', nullable: true},
}

// No `id` on chunks and issues: Orrery numbers them in their project (chunks 1, 2, …, issues KEY-1, …).
export const CHUNK_FIELDS: Record<string, Field> = {
    title: {type: 'string', required: true},
    summary: {type: 'string', nullable: true},
    priority: {type: 'string', values: PRIORITIES, nullable: true},
    position: {type: 'number'},
}

export const ISSUE_FIELDS: Record<string, Field> = {
    title: {type: 'string', required: true},
    status: {type: 'string', values: STATUSES},
    plan: {type: 'string', values: PLANS, nullable: true},
    priority: {type: 'string', values: PRIORITIES, nullable: true},
    assignee: {type: 'string', nullable: true},
    labels: {type: 'strings', nullable: true},
    notes: {type: 'string', nullable: true},
    /** Only on an update: moves the issue, its sub-issues and their comments to another project. */
    project: {type: 'string', pattern: SLUG, hint: "use the other project's id"},
    parent: {type: 'string', nullable: true},
    chunk: {type: 'string', nullable: true},
    position: {type: 'number'},
}

export const DOC_FIELDS: Record<string, Field> = {
    id: {type: 'string', pattern: SLUG, hint: 'use lowercase letters, digits and dashes'},
    title: {type: 'string', required: true},
    body: {type: 'string'},
    position: {type: 'number'},
}

export const SIGNAL_FIELDS: Record<string, Field> = {
    note: {type: 'string', nullable: true},
    /** A session id; left out, every session on the project gets it. */
    session: {type: 'string', nullable: true},
}

export const COMMENT_FIELDS: Record<string, Field> = {
    body: {type: 'string', required: true},
}

export class Store {
    constructor(
        readonly db: DatabaseSync,
        private readonly onChange: (project: string) => void = () => {},
        private readonly onSignal: (signal: Signal) => void = () => {},
        private readonly onNotice: (notice: Notice) => void = () => {},
    ) {}

    /** Agents' latest comments across projects (what the bell shows), newest first. */
    notices(limit = 30): Notice[] {
        return this.all<CommentRow & {title: string}>(`
            SELECT c.*, i.title FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue
            WHERE c.owned = 0 ORDER BY c.created_at DESC, c.id DESC LIMIT ?`, limit)
            .map(row => ({...commentOf(row), project: row.project, title: row.title}))
    }

    // Projects

    listProjects(): ProjectSummary[] {
        return this.all<ProjectRow>('SELECT * FROM projects ORDER BY name COLLATE NOCASE').map(row => {
            const {board, ...project} = this.projectOf(row)
            return {...project, counts: board.counts, chunks: board.chunks.filter(c => c.id).length}
        })
    }

    listBoards(): Project[] {
        return this.all<ProjectRow>('SELECT * FROM projects ORDER BY name COLLATE NOCASE').map(row => this.projectOf(row))
    }

    project(id: string): Project {
        return this.projectOf(this.projectRow(id))
    }

    createProject(body: unknown, actor = AGENT): Project {
        const input = checkInput(body, PROJECT_FIELDS)
        const name = String(input.name).trim()
        const id = input.id ? String(input.id) : slugify(name)
        if (!SLUG.test(id)) throw badRequest(`"${name}" doesn't make an id; give one in "id"`)
        if (this.get('SELECT 1 FROM projects WHERE id = ?', id)) throw conflict(`There is already a project "${id}"`)
        const key = input.key ? String(input.key) : keyFor(name)
        const now = stamp()
        this.run('INSERT INTO projects (id, name, key, description, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            id, name, key, nullable(input.description), actor.name, Number(actor.owner), now, now)
        this.onChange(id)
        return this.project(id)
    }

    updateProject(id: string, body: unknown): Project {
        this.projectRow(id)
        const input = checkInput(body, PROJECT_FIELDS, true)
        if (input.id !== undefined && input.id !== id) throw badRequest("A project's id can't change")
        this.update('projects', 'id = ?', [id], {
            name: input.name === undefined ? undefined : String(input.name).trim(),
            key: input.key,
            description: input.description,
        })
        this.onChange(id)
        return this.project(id)
    }

    deleteProject(id: string, actor = AGENT) {
        this.refuse(actor, `Deleting ${id}`, this.ownedIn(id))
        transaction(this.db, () => {
            // Comments and issues first: the foreign keys would refuse the project going before them.
            this.run('DELETE FROM comments WHERE project = ?', id)
            this.run('UPDATE issues SET parent = NULL, chunk = NULL WHERE project = ?', id)
            this.run('DELETE FROM issues WHERE project = ?', id)
            this.run('DELETE FROM chunks WHERE project = ?', id)
            this.run('DELETE FROM docs WHERE project = ?', id)
            this.run('DELETE FROM issue_aliases WHERE project = ?', id)
            this.run('DELETE FROM chunk_aliases WHERE project = ?', id)
            this.run('DELETE FROM signals WHERE project = ?', id)
            this.run('DELETE FROM projects WHERE id = ?', id)
        })
        this.onChange(id)
    }

    // Chunks

    listChunks(project: string): ChunkRecord[] {
        const {board} = this.project(project)
        return this.all<ChunkRow>('SELECT * FROM chunks WHERE project = ? ORDER BY position, created_at', project)
            .map(row => this.chunkRecord(row, board.chunks.find(c => c.id === row.id)!))
    }

    chunk(project: string, id: string): ChunkRecord & {tasks: Issue[]} {
        id = this.chunkId(project, id)
        const row = this.chunkRow(project, id)
        const view = this.project(project).board.chunks.find(c => c.id === id)!
        return {...this.chunkRecord(row, view), tasks: view.tasks}
    }

    createChunk(project: string, body: unknown, actor = AGENT): ChunkRecord & {tasks: Issue[]} {
        this.projectRow(project)
        const input = checkInput(body, CHUNK_FIELDS)
        const title = String(input.title).trim()
        const now = stamp()
        const id = transaction(this.db, () => {
            const id = this.nextId(project, 'chunk')
            this.run('INSERT INTO chunks (project, id, title, summary, priority, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, nullable(input.summary), nullable(input.priority), Number(input.position ?? this.nextPosition('chunks', project)), actor.name, Number(actor.owner), now, now)
            this.touchProject(project)
            return id
        })
        this.onChange(project)
        return this.chunk(project, id)
    }

    updateChunk(project: string, id: string, body: unknown): ChunkRecord & {tasks: Issue[]} {
        id = this.chunkId(project, id)
        this.chunkRow(project, id)
        const input = checkInput(body, CHUNK_FIELDS, true)
        transaction(this.db, () => {
            this.update('chunks', 'project = ? AND id = ?', [project, id], {
                title: input.title === undefined ? undefined : String(input.title).trim(),
                summary: input.summary,
                priority: input.priority,
                position: input.position,
            })
            this.touchProject(project)
        })
        this.onChange(project)
        return this.chunk(project, id)
    }

    /** Its issues stay, in no chunk (as Linear does with a deleted milestone). */
    deleteChunk(project: string, id: string, actor = AGENT) {
        id = this.chunkId(project, id)
        const row = this.chunkRow(project, id)
        this.refuse(actor, `Deleting chunk "${id}"`, row.owned ? [`chunk "${id}"`] : [])
        transaction(this.db, () => {
            this.run('UPDATE issues SET chunk = NULL WHERE project = ? AND chunk = ?', project, id)
            this.run('DELETE FROM chunk_aliases WHERE project = ? AND chunk = ?', project, id)
            this.run('DELETE FROM signals WHERE project = ? AND chunk = ?', project, id)
            this.run('DELETE FROM chunks WHERE project = ? AND id = ?', project, id)
            this.touchProject(project)
        })
        this.onChange(project)
    }

    // Issues

    listIssues(project: string, filter: IssueFilter = {}): IssueRecord[] {
        const records = this.issueRecords(this.project(project))
        if (filter.chunk && filter.chunk !== 'none') filter = {...filter, chunk: this.chunkId(project, filter.chunk)}
        const q = filter.q?.toLowerCase()
        return records.filter(r =>
            (!filter.status || r.status === filter.status)
            && (!filter.plan || (filter.plan === 'none' ? !r.plan : r.plan === filter.plan))
            && (!filter.priority || (filter.priority === 'none' ? !r.priority : r.priority === filter.priority))
            && (!filter.column || r.column === filter.column)
            && (!filter.assignee || (filter.assignee === 'none' ? !r.assignee : r.assignee === filter.assignee))
            && (!filter.label || r.labels.includes(filter.label))
            && (!filter.chunk || (filter.chunk === 'none' ? !r.chunk : r.chunk === filter.chunk))
            && (!filter.parent || (filter.parent === 'none' ? !r.parent : r.parent === filter.parent))
            && (!q || r.id.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)))
    }

    issue(project: string, id: string): IssueDetail {
        id = this.issueId(project, id)
        const found = this.findIssue(this.project(project), id)
        if (!found) throw notFound(`No issue ${id} in ${project}`)
        return {...found.issue, project, parent: found.parent, chunk: found.chunk || null}
    }

    createIssue(project: string, body: unknown, actor = AGENT): IssueDetail {
        this.projectRow(project)
        const input = checkInput(body, ISSUE_FIELDS)
        if (input.project !== undefined && input.project !== project) throw badRequest(`Create the issue in its project: POST /api/projects/${input.project}/issues`)
        const parent = input.parent ? this.issueId(project, String(input.parent)) : null
        const chunk = input.chunk ? this.chunkId(project, String(input.chunk)) : null
        if (parent) {
            this.issueRow(project, parent)
            if (chunk) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or "parent"`)
        }
        if (chunk) this.chunkRow(project, chunk)

        const id = transaction(this.db, () => {
            const id = this.nextId(project, 'issue')
            const now = stamp()
            this.run(`INSERT INTO issues (project, id, title, status, plan, priority, assignee, labels, notes, parent, chunk, position,
                                          created_by, owned, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, id, String(input.title).trim(), String(input.status ?? 'todo'), nullable(input.plan), nullable(input.priority),
                nullable(input.assignee), JSON.stringify(input.labels ?? []), nullable(input.notes),
                parent, chunk, Number(input.position ?? this.nextPosition('issues', project)), actor.name, Number(actor.owner), now, now)
            this.touchProject(project)
            return id
        })
        this.onChange(project)
        return this.issue(project, id)
    }

    /** `parent: null` lifts a sub-issue to the top, into the chunk it was in unless `chunk` says otherwise.
     * `project` moves it (with its sub-issues and comments) to the top of another project. */
    updateIssue(project: string, id: string, body: unknown): IssueDetail {
        id = this.issueId(project, id)
        this.issueRow(project, id)
        const input = checkInput(body, ISSUE_FIELDS, true)
        if (input.project !== undefined && input.project !== project) {
            const {project: to, parent, chunk, ...rest} = input
            const moved = this.moveIssue(project, id, String(to), parent ?? null, chunk ?? null)
            return this.updateIssue(String(to), moved, rest)
        }
        const row = this.issueRow(project, id)

        const parent = input.parent === undefined ? row.parent : input.parent === null ? null : this.issueId(project, String(input.parent))
        let chunk = input.chunk === undefined ? undefined : input.chunk === null ? null : this.chunkId(project, String(input.chunk))
        if (parent) {
            if (chunk) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or set "parent" to null`)
            this.issueRow(project, parent)
            for (let up: string | null = parent; up; up = this.issueRow(project, up).parent) {
                if (up === id) throw badRequest(`${parent} is ${up === parent ? 'this issue' : 'under this issue'}, so it can't be its parent`)
            }
            chunk = null
        } else if (chunk === undefined && row.parent) {
            chunk = this.rootOf(project, row).chunk
        }
        if (chunk) this.chunkRow(project, chunk)

        transaction(this.db, () => {
            this.update('issues', 'project = ? AND id = ?', [project, id], {
                title: input.title === undefined ? undefined : String(input.title).trim(),
                status: input.status,
                plan: input.plan,
                priority: input.priority,
                assignee: input.assignee,
                labels: input.labels === undefined ? undefined : JSON.stringify(input.labels ?? []),
                notes: input.notes,
                parent: input.parent === undefined ? undefined : parent,
                chunk,
                position: input.position,
            })
            this.touchProject(project)
        })
        this.onChange(project)
        return this.issue(project, id)
    }

    /** Deletes its sub-issues and comments too. */
    deleteIssue(project: string, id: string, actor = AGENT) {
        id = this.issueId(project, id)
        this.issueRow(project, id)
        const subtree = this.subtree(project, id)
        this.refuse(actor, `Deleting ${id}`, this.ownedUnder(project, subtree))
        transaction(this.db, () => {
            this.run(`DELETE FROM issue_aliases WHERE project = ? AND issue IN (${subtree.map(() => '?').join(', ')})`, project, ...subtree)
            // Its signals too, so a session catching up isn't told about an issue that's gone.
            this.run(`DELETE FROM signals WHERE project = ? AND issue IN (${subtree.map(() => '?').join(', ')})`, project, ...subtree)
            this.run('DELETE FROM issues WHERE project = ? AND id = ?', project, id)
            this.touchProject(project)
        })
        this.onChange(project)
    }

    /** Moves an issue and everything under it to `to`, where they get its ids (KEY-n); the ids they had
     * stay as aliases there. Says the issue's new id. */
    private moveIssue(from: string, id: string, to: string, parent: Input[string], chunk: Input[string]): string {
        this.projectRow(to)
        const parentId = parent ? this.issueId(to, String(parent)) : null
        const chunkId = chunk ? this.chunkId(to, String(chunk)) : null
        if (parentId) this.issueRow(to, parentId)
        if (parentId && chunkId) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or "parent"`)
        if (chunkId) this.chunkRow(to, chunkId)
        const subtree = this.subtree(from, id)
        const marks = subtree.map(() => '?').join(', ')
        const moved = transaction(this.db, () => {
            // Rows move first and get their new ids and links after, so the foreign keys wait for the commit.
            this.db.exec('PRAGMA defer_foreign_keys = ON')
            const names = new Map(subtree.map(old => [old, this.nextId(to, 'issue')]))
            const links = this.all<{id: string, parent: string | null}>(`SELECT id, parent FROM issues WHERE project = ? AND id IN (${marks})`, from, ...subtree)
            const comments = this.all<{id: number, issue: string}>(`SELECT id, issue FROM comments WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            const aliases = this.all<{alias: string, issue: string}>(`SELECT alias, issue FROM issue_aliases WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            const position = this.nextPosition('issues', to)
            for (const link of links) {
                const next = names.get(link.id)!
                this.run('UPDATE issues SET project = ?, id = ?, parent = ?, chunk = ?, position = position + ? WHERE project = ? AND id = ?',
                    to, next, link.id === id ? parentId : names.get(link.parent!) ?? null, link.id === id && !parentId ? chunkId : null, position, from, link.id)
            }
            for (const comment of comments) this.run('UPDATE comments SET project = ?, issue = ? WHERE id = ?', to, names.get(comment.issue)!, comment.id)
            this.run(`DELETE FROM issue_aliases WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            for (const {alias, issue} of aliases) this.run('INSERT OR REPLACE INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', to, alias, names.get(issue)!)
            for (const [old, next] of names) this.run('INSERT OR REPLACE INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', to, old, next)
            this.run('UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?', stamp(), to, names.get(id)!)
            this.touchProject(from)
            this.touchProject(to)
            return names.get(id)!
        })
        this.onChange(from)
        this.onChange(to)
        return moved
    }

    /** The issue's id and every id under it. */
    private subtree(project: string, id: string): string[] {
        return [id, ...this.all<{id: string}>('SELECT id FROM issues WHERE project = ? AND parent = ?', project, id).flatMap(c => this.subtree(project, c.id))]
    }

    // Comments

    listComments(project: string, issue: string): Comment[] {
        issue = this.issueId(project, issue)
        this.issueRow(project, issue)
        return this.all<CommentRow>('SELECT * FROM comments WHERE project = ? AND issue = ? ORDER BY created_at, id', project, issue).map(commentOf)
    }

    comment(project: string, issue: string, id: number): Comment {
        issue = this.issueId(project, issue)
        return commentOf(this.commentRow(project, issue, id))
    }

    createComment(project: string, issue: string, body: unknown, actor = AGENT): Comment {
        issue = this.issueId(project, issue)
        this.issueRow(project, issue)
        const input = checkInput(body, COMMENT_FIELDS)
        const now = stamp()
        const id = transaction(this.db, () => {
            const {lastInsertRowid} = this.run('INSERT INTO comments (project, issue, body, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                project, issue, String(input.body), actor.name, Number(actor.owner), now, now)
            this.touchIssue(project, issue)
            return Number(lastInsertRowid)
        })
        this.onChange(project)
        if (actor.owner) this.carryComment(project, issue, String(input.body), actor)
        else this.onNotice({...this.comment(project, issue, id), project, title: this.issueRow(project, issue).title})
        return this.comment(project, issue, id)
    }

    /** The owner's comments in the project that no agent has answered and no session has had yet,
     * sent to `session` (just connected) to catch up on. Says how many. */
    carryUnanswered(project: string, session: string): number {
        const waiting = this.all<{issue: string, body: string, created_by: string}>(`
            SELECT c.issue, c.body, c.created_by FROM comments c
            WHERE c.project = ? AND c.owned = 1
              AND NOT EXISTS (SELECT 1 FROM comments a WHERE a.project = c.project AND a.issue = c.issue AND a.owned = 0 AND a.id > c.id)
              AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.project = c.project AND s.issue = c.issue AND s.kind = 'comment'
                              AND s.created_at >= c.created_at AND s.delivered_to != '[]')
            ORDER BY c.created_at LIMIT 10`, project)
        for (const comment of waiting) {
            const {lastInsertRowid} = this.run('INSERT INTO signals (project, issue, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                project, comment.issue, 'comment', comment.body, session, comment.created_by, 1, stamp())
            this.onSignal(signalOf(this.get<SignalRow>('SELECT * FROM signals WHERE id = ?', Number(lastInsertRowid))!))
        }
        return waiting.length
    }

    /** The owner's comment goes to the session last asked to focus on the issue (or, if none was,
     * every session on the project), so it can answer. */
    private carryComment(project: string, issue: string, body: string, actor: Actor) {
        const target = this.get<{target: string}>("SELECT target FROM signals WHERE project = ? AND issue = ? AND kind = 'focus' AND target IS NOT NULL ORDER BY id DESC LIMIT 1", project, issue)?.target ?? null
        const {lastInsertRowid} = this.run('INSERT INTO signals (project, issue, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            project, issue, 'comment', body, target, actor.name, 1, stamp())
        this.onSignal(signalOf(this.get<SignalRow>('SELECT * FROM signals WHERE id = ?', Number(lastInsertRowid))!))
    }

    /** The owner's comments are theirs: an agent can't reword them. */
    updateComment(project: string, issue: string, id: number, body: unknown, actor = AGENT): Comment {
        issue = this.issueId(project, issue)
        const row = this.commentRow(project, issue, id)
        this.refuse(actor, `Editing comment ${id}`, row.owned ? [`comment ${id}`] : [])
        const input = checkInput(body, COMMENT_FIELDS, true)
        transaction(this.db, () => {
            this.update('comments', 'id = ?', [id], {body: input.body})
            this.touchIssue(project, issue)
        })
        this.onChange(project)
        return this.comment(project, issue, id)
    }

    deleteComment(project: string, issue: string, id: number, actor = AGENT) {
        issue = this.issueId(project, issue)
        const row = this.commentRow(project, issue, id)
        this.refuse(actor, `Deleting comment ${id}`, row.owned ? [`comment ${id}`] : [])
        transaction(this.db, () => {
            this.run('DELETE FROM comments WHERE id = ?', id)
            this.touchIssue(project, issue)
        })
        this.onChange(project)
    }

    // Docs

    listDocs(project: string): DocSummary[] {
        this.projectRow(project)
        return this.docSummaries(project)
    }

    doc(project: string, id: string): Doc {
        return docOf(this.docRow(project, id))
    }

    createDoc(project: string, body: unknown, actor = AGENT): Doc {
        this.projectRow(project)
        const input = checkInput(body, DOC_FIELDS)
        const title = String(input.title).trim()
        let id = input.id ? String(input.id) : slugify(title) || 'doc'
        if (input.id) {
            if (this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) throw conflict(`There is already a doc "${id}" in ${project}`)
        } else {
            const base = id
            for (let n = 2; this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id); n++) id = `${base}-${n}`
        }
        const now = stamp()
        transaction(this.db, () => {
            this.run('INSERT INTO docs (project, id, title, body, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, String(input.body ?? ''), Number(input.position ?? this.nextPosition('docs', project)), actor.name, Number(actor.owner), now, now)
            this.touchProject(project)
        })
        this.onChange(project)
        return this.doc(project, id)
    }

    /** Creates the doc at `id` or replaces its title and text: how a repo's Markdown file is kept in sync. */
    putDoc(project: string, id: string, body: unknown, actor = AGENT): {doc: Doc, created: boolean} {
        this.projectRow(project)
        if (!SLUG.test(id)) throw badRequest(`"${id}" isn't a doc id; use lowercase letters, digits and dashes`)
        const input = checkInput(body, DOC_FIELDS)
        if (input.id !== undefined && input.id !== id) throw badRequest(`The body's id "${input.id}" isn't the URL's "${id}"`)
        if (!this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) return {doc: this.createDoc(project, {...input, id}, actor), created: true}
        return {doc: this.updateDoc(project, id, {title: input.title, body: input.body ?? '', position: input.position}), created: false}
    }

    updateDoc(project: string, id: string, body: unknown): Doc {
        this.docRow(project, id)
        const input = checkInput(body, DOC_FIELDS, true)
        if (input.id !== undefined && input.id !== id) throw badRequest("A doc's id can't change")
        transaction(this.db, () => {
            this.update('docs', 'project = ? AND id = ?', [project, id], {
                title: input.title === undefined ? undefined : String(input.title).trim(),
                body: input.body,
                position: input.position,
            })
            this.touchProject(project)
        })
        this.onChange(project)
        return this.doc(project, id)
    }

    deleteDoc(project: string, id: string, actor = AGENT) {
        const row = this.docRow(project, id)
        this.refuse(actor, `Deleting doc "${id}"`, row.owned ? [`doc "${id}"`] : [])
        transaction(this.db, () => {
            this.run('DELETE FROM docs WHERE project = ? AND id = ?', project, id)
            this.touchProject(project)
        })
        this.onChange(project)
    }

    // Signals

    /** Asks the sessions on the project to focus on the issue (`{note?}` says what for). */
    focus(project: string, issue: string, body: unknown, actor = AGENT): Signal {
        issue = this.issueId(project, issue)
        this.issueRow(project, issue)
        const input = checkInput(body ?? {}, SIGNAL_FIELDS)
        const {lastInsertRowid} = this.run('INSERT INTO signals (project, issue, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            project, issue, 'focus', nullable(input.note), nullable(input.session), actor.name, Number(actor.owner), stamp())
        const signal = signalOf(this.get<SignalRow>('SELECT * FROM signals WHERE id = ?', Number(lastInsertRowid))!)
        this.onSignal(signal)
        return signal
    }

    /** Asks the sessions (or `session`) to work through the chunk's open issues now. */
    focusChunk(project: string, chunk: string, body: unknown, actor = AGENT): Signal {
        chunk = this.chunkId(project, chunk)
        this.chunkRow(project, chunk)
        const input = checkInput(body ?? {}, SIGNAL_FIELDS)
        const {lastInsertRowid} = this.run('INSERT INTO signals (project, chunk, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            project, chunk, 'focus', nullable(input.note), nullable(input.session), actor.name, Number(actor.owner), stamp())
        const signal = signalOf(this.get<SignalRow>('SELECT * FROM signals WHERE id = ?', Number(lastInsertRowid))!)
        this.onSignal(signal)
        return signal
    }

    /** The project's signals after `after` (an id), oldest first; or the latest ones about an issue or a chunk. */
    listSignals(project: string, after = 0, limit = 50, about?: {issue?: string, chunk?: string}): Signal[] {
        this.projectRow(project)
        if (about?.issue || about?.chunk) {
            const [column, id] = about.issue ? ['issue', this.issueId(project, about.issue)] : ['chunk', this.chunkId(project, about.chunk!)]
            return this.all<SignalRow>(`SELECT * FROM signals WHERE project = ? AND ${column} = ? ORDER BY id DESC LIMIT ?`, project, id, limit)
                .reverse().map(signalOf)
        }
        return this.all<SignalRow>('SELECT * FROM signals WHERE project = ? AND id > ? ORDER BY id LIMIT ?', project, after, limit).map(signalOf)
    }

    /** Notes that a session got the signal. */
    delivered(project: string, id: number, to: string): Signal {
        const row = this.get<SignalRow>('SELECT * FROM signals WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No signal ${id} in ${project}`)
        const names = [...new Set([...JSON.parse(row.delivered_to) as string[], to])]
        this.run('UPDATE signals SET delivered_to = ? WHERE id = ?', JSON.stringify(names), id)
        const signal = signalOf({...row, delivered_to: JSON.stringify(names)})
        this.onSignal(signal)
        return signal
    }

    // Import

    /** Loads a roadmap in `docs/roadmap.json`'s format; `replace` first clears the project's chunks and issues.
     * Everything gets the project's ids (chunks 1, 2, …, issues KEY-1, …), the file's ids becoming aliases. */
    importRoadmap(project: string, roadmap: RoadmapFile, replace = false, actor = AGENT): Project {
        this.projectRow(project)
        if (replace) this.refuse(actor, `Replacing ${project}'s roadmap`, this.ownedIn(project).filter(what => !what.startsWith('project ') && !what.startsWith('doc ')))
        const has = this.get('SELECT 1 FROM issues WHERE project = ? UNION SELECT 1 FROM chunks WHERE project = ?', project, project)
        if (has && !replace) throw conflict(`${project} already has chunks or issues; import with ?replace=true to replace them`)

        const now = stamp()
        let position = 0
        const insert = (task: TaskFile, parent: string | null, chunk: string | null) => {
            this.run(`INSERT INTO issues (project, id, title, status, plan, priority, assignee, labels, notes, parent, chunk, position,
                                          created_by, owned, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, task.id, task.title, task.status, task.plan ?? null, task.priority ?? null, task.assignee ?? null, JSON.stringify(task.labels),
                task.notes ?? null, parent, chunk, position++, actor.name, Number(actor.owner), now, now)
            task.tasks.forEach(sub => insert(sub, task.id, null))
        }
        transaction(this.db, () => {
            this.db.exec('PRAGMA defer_foreign_keys = ON')
            if (replace) {
                this.run('DELETE FROM comments WHERE project = ?', project)
                this.run('UPDATE issues SET parent = NULL, chunk = NULL WHERE project = ?', project)
                this.run('DELETE FROM issues WHERE project = ?', project)
                this.run('DELETE FROM chunks WHERE project = ?', project)
                this.run('DELETE FROM issue_aliases WHERE project = ?', project)
                this.run('DELETE FROM chunk_aliases WHERE project = ?', project)
            }
            roadmap.chunks.forEach((chunk, i) => {
                this.run('INSERT INTO chunks (project, id, title, summary, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    project, chunk.id, chunk.title, chunk.summary || null, i, actor.name, Number(actor.owner), now, now)
                chunk.tasks.forEach(task => insert(task, null, chunk.id))
            })
            renumber(this.db, project)
            this.touchProject(project)
        })
        this.onChange(project)
        return this.project(project)
    }

    // Reading

    private projectOf(row: ProjectRow): Project {
        return {
            id: row.id,
            name: row.name,
            key: row.key,
            description: row.description ?? undefined,
            createdBy: row.created_by,
            protected: !!row.owned,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            board: this.board(row.id),
            docs: this.docSummaries(row.id),
        }
    }

    private docSummaries(project: string): DocSummary[] {
        return this.all<DocRow>('SELECT * FROM docs WHERE project = ? ORDER BY position, created_at', project)
            .map(row => ({id: row.id, title: row.title, createdBy: row.created_by, protected: !!row.owned, createdAt: row.created_at, updatedAt: row.updated_at}))
    }

    private board(project: string): Board {
        const chunks = this.all<ChunkRow>('SELECT * FROM chunks WHERE project = ? ORDER BY position, created_at', project)
        const issues = this.all<IssueRow>('SELECT * FROM issues WHERE project = ? ORDER BY position, created_at', project)
        const comments = new Map(this.all<{issue: string, n: number}>('SELECT issue, count(*) AS n FROM comments WHERE project = ? GROUP BY issue', project)
            .map(r => [r.issue, r.n]))
        const aliases = (table: 'issue_aliases' | 'chunk_aliases', column: 'issue' | 'chunk') => {
            const found = new Map<string, string[]>()
            for (const row of this.all<{alias: string, of: string}>(`SELECT alias, ${column} AS of FROM ${table} WHERE project = ? ORDER BY alias`, project)) {
                found.set(row.of, [...found.get(row.of) ?? [], row.alias])
            }
            return found
        }
        const issueAliases = aliases('issue_aliases', 'issue')
        const chunkAliases = aliases('chunk_aliases', 'chunk')
        const children = new Map<string | null, IssueRow[]>()
        for (const row of issues) children.set(row.parent, [...children.get(row.parent) ?? [], row])

        const input = (row: IssueRow): IssueInput => ({
            id: row.id,
            title: row.title,
            priority: row.priority ?? undefined,
            assignee: row.assignee ?? undefined,
            labels: JSON.parse(row.labels) as string[],
            status: row.status,
            plan: row.plan ?? undefined,
            notes: row.notes ?? undefined,
            comments: comments.get(row.id) ?? 0,
            aliases: issueAliases.get(row.id) ?? [],
            createdBy: row.created_by,
            protected: !!row.owned,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            tasks: (children.get(row.id) ?? []).map(input),
        })
        const top = children.get(null) ?? []
        const grouped = chunks.map(c => ({
            id: c.id, title: c.title, summary: c.summary ?? '', priority: c.priority ?? undefined, aliases: chunkAliases.get(c.id) ?? [], createdBy: c.created_by, protected: !!c.owned,
            tasks: top.filter(t => t.chunk === c.id).map(input),
        }))
        const loose = top.filter(t => !t.chunk)
        if (loose.length) grouped.push({id: '', title: 'No chunk', summary: '', priority: undefined, aliases: [], createdBy: '', protected: false, tasks: loose.map(input)})
        return buildBoard({chunks: grouped})
    }

    private issueRecords(project: Project): IssueRecord[] {
        const records: IssueRecord[] = []
        const walk = (issues: Issue[], parent: string | null, chunk: string) => {
            for (const {tasks, ...issue} of issues) {
                records.push({...issue, project: project.id, parent, chunk: chunk || null, subIssues: tasks.map(t => t.id)})
                walk(tasks, issue.id, chunk)
            }
        }
        project.board.chunks.forEach(c => walk(c.tasks, null, c.id))
        return records
    }

    private findIssue(project: Project, id: string): {issue: Issue, parent: string | null, chunk: string} | null {
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

    private chunkRecord(row: ChunkRow, view: Chunk): ChunkRecord {
        const {tasks, ...chunk} = view
        return {...chunk, project: row.project, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at, issues: tasks.map(t => t.id)}
    }

    /** The issue's id, from its id or an id it had before (an alias). */
    private issueId(project: string, id: string): string {
        if (this.get('SELECT 1 FROM issues WHERE project = ? AND id = ?', project, id)) return id
        return this.get<{issue: string}>('SELECT issue FROM issue_aliases WHERE project = ? AND alias = ?', project, id)?.issue ?? id
    }

    /** The chunk's id, from its number or a name it had before (an alias). */
    private chunkId(project: string, id: string): string {
        if (this.get('SELECT 1 FROM chunks WHERE project = ? AND id = ?', project, id)) return id
        return this.get<{chunk: string}>('SELECT chunk FROM chunk_aliases WHERE project = ? AND alias = ?', project, id)?.chunk ?? id
    }

    /** Hands out the project's next id: KEY-n for an issue, n for a chunk. Run inside the write's transaction. */
    private nextId(project: string, kind: 'issue' | 'chunk'): string {
        const row = this.projectRow(project)
        const [column, table] = kind === 'issue' ? ['next_number', 'issues'] as const : ['next_chunk', 'chunks'] as const
        const name = (n: number) => kind === 'issue' ? `${row.key}-${n}` : String(n)
        let n = kind === 'issue' ? row.next_number : row.next_chunk
        while (this.get(`SELECT 1 FROM ${table} WHERE project = ? AND id = ?`, project, name(n))) n++
        this.run(`UPDATE projects SET ${column} = ? WHERE id = ?`, n + 1, project)
        return name(n)
    }

    private rootOf(project: string, row: IssueRow): IssueRow {
        let root = row
        while (root.parent) root = this.issueRow(project, root.parent)
        return root
    }

    private projectRow(id: string): ProjectRow {
        const row = this.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
        if (!row) throw notFound(`No project "${id}"`)
        return row
    }

    private chunkRow(project: string, id: string): ChunkRow {
        this.projectRow(project)
        const row = this.get<ChunkRow>('SELECT * FROM chunks WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No chunk "${id}" in ${project}`)
        return row
    }

    private issueRow(project: string, id: string): IssueRow {
        this.projectRow(project)
        const row = this.get<IssueRow>('SELECT * FROM issues WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No issue ${id} in ${project}`)
        return row
    }

    private docRow(project: string, id: string): DocRow {
        this.projectRow(project)
        const row = this.get<DocRow>('SELECT * FROM docs WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No doc "${id}" in ${project}`)
        return row
    }

    private commentRow(project: string, issue: string, id: number): CommentRow {
        this.issueRow(project, issue)
        const row = this.get<CommentRow>('SELECT * FROM comments WHERE project = ? AND issue = ? AND id = ?', project, issue, id)
        if (!row) throw notFound(`No comment ${id} on ${issue}`)
        return row
    }

    // Protection

    /** Refuses an agent `action` when it would take away what the owner made. */
    private refuse(actor: Actor, action: string, owned: string[]) {
        if (actor.owner || !owned.length) return
        const shown = owned.length > 4 ? [...owned.slice(0, 3), `${owned.length - 3} more`] : owned
        throw forbidden(`${action} is the owner's call: ${shown.join(', ')} ${owned.length === 1 ? 'was' : 'were'} made by the owner`)
    }

    /** What the owner made in the project, the project included. */
    private ownedIn(project: string): string[] {
        const row = this.projectRow(project)
        return [
            ...row.owned ? [`project "${project}"`] : [],
            ...this.all<{id: string}>('SELECT id FROM chunks WHERE project = ? AND owned = 1', project).map(c => `chunk "${c.id}"`),
            ...this.all<{id: string}>('SELECT id FROM docs WHERE project = ? AND owned = 1', project).map(d => `doc "${d.id}"`),
            ...this.ownedUnder(project, this.all<{id: string}>('SELECT id FROM issues WHERE project = ?', project).map(i => i.id)),
        ]
    }

    /** The owner's issues and comments among these issues. */
    private ownedUnder(project: string, issues: string[]): string[] {
        if (!issues.length) return []
        const marks = issues.map(() => '?').join(', ')
        return [
            ...this.all<{id: string}>(`SELECT id FROM issues WHERE project = ? AND owned = 1 AND id IN (${marks})`, project, ...issues).map(i => i.id),
            ...this.all<{id: number, issue: string}>(`SELECT id, issue FROM comments WHERE project = ? AND owned = 1 AND issue IN (${marks})`, project, ...issues)
                .map(c => `comment ${c.id} on ${c.issue}`),
        ]
    }

    // Writing

    /** Sets the given fields (undefined ones are left as they are) and the update time. */
    private update(table: string, where: string, keys: SQLInputValue[], fields: Input) {
        const set = Object.entries(fields).filter(([, value]) => value !== undefined)
        const columns = [...set.map(([column]) => `${column} = ?`), 'updated_at = ?']
        this.run(`UPDATE ${table} SET ${columns.join(', ')} WHERE ${where}`, ...set.map(([, value]) => value as SQLInputValue), stamp(), ...keys)
    }

    private touchProject(project: string) {
        this.run('UPDATE projects SET updated_at = ? WHERE id = ?', stamp(), project)
    }

    private touchIssue(project: string, issue: string) {
        const now = stamp()
        this.run('UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?', now, project, issue)
        this.run('UPDATE projects SET updated_at = ? WHERE id = ?', now, project)
    }

    private nextPosition(table: 'chunks' | 'issues' | 'docs', project: string): number {
        return (this.get<{n: number | null}>(`SELECT max(position) AS n FROM ${table} WHERE project = ?`, project)?.n ?? -1) + 1
    }

    private run(sql: string, ...params: SQLInputValue[]) {
        return this.db.prepare(sql).run(...params)
    }

    private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
        return this.db.prepare(sql).get(...params) as T | undefined
    }

    private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
        return this.db.prepare(sql).all(...params) as T[]
    }
}

function commentOf(row: CommentRow): Comment {
    return {id: row.id, issue: row.issue, body: row.body, createdBy: row.created_by, protected: !!row.owned, createdAt: row.created_at, updatedAt: row.updated_at}
}

function signalOf(row: SignalRow): Signal {
    return {
        id: row.id, project: row.project, issue: row.issue ?? undefined, chunk: row.chunk ?? undefined, kind: row.kind, note: row.note ?? undefined,
        target: row.target ?? undefined, deliveredTo: JSON.parse(row.delivered_to) as string[], createdBy: row.created_by, protected: !!row.owned, createdAt: row.created_at,
    }
}

function docOf(row: DocRow): Doc {
    return {
        id: row.id, project: row.project, title: row.title, body: row.body,
        createdBy: row.created_by, protected: !!row.owned, createdAt: row.created_at, updatedAt: row.updated_at,
    }
}

function nullable(value: Input[string]): string | null {
    return value === undefined || value === null ? null : String(value)
}

function stamp() {
    return new Date().toISOString()
}

export function slugify(text: string): string {
    return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
}

/** Three capitals from the name, e.g. `MES` for mesher. */
function keyFor(name: string): string {
    const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '')
    return letters.slice(0, 3) || 'ISS'
}
