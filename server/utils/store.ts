// Projects, chunks, issues and comments: reading and changing them, and the rules they keep.
// Issues nest (a parent holds sub-issues, to any depth); only a top-level issue is in a chunk, its
// sub-issues are in the same one. Every change ends with `onChange(project)`, which the server
// turns into a server-sent event, so open pages update.
import type {DatabaseSync, SQLInputValue} from 'node:sqlite'
import type {ActivityField, Asks, Board, Chunk, Comment, IssueEvent, Owner, Settings, Counts, Decision, Doc, DocSummary, Issue, IssueStatus, Kind, Kinds, Notice, Priority, Project, Proposal, Signal} from '#shared/roadmap'
import {ASKS, CLOSED, DECISIONS, KINDS, PRIORITIES, TINTS} from '#shared/roadmap'
import type {Field, Input} from './input'
import {badRequest, checkInput, conflict, forbidden, notFound} from './input'
import type {IssueInput, RoadmapFile, TaskFile} from './roadmap'
import {LEGACY_PLANS, buildBoard, legacyStatus} from './roadmap'
import {transaction} from './db'
import type {Instruction} from '#shared/prompt'
import {DEFAULT_CHUNK_PROMPT, DEFAULT_FOCUS_PROMPT, defaultInstructions} from '#shared/prompt'
import {renumber} from './renumber'

/** A project without its board, as `GET /api/projects` lists it. */
export interface ProjectSummary extends Omit<Project, 'board'> {
    counts: Counts
    kinds: Kinds
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
    /** A status's id, or a kind (`started`): what the issue says. */
    status?: string
    priority?: string
    /** A status's id, or a kind, or `proposed`: where the board puts it. */
    column?: string
    /** A name, or `none` for unassigned issues. */
    assignee?: string
    label?: string
    chunk?: string
    /** An issue id, or `none` for top-level issues. */
    parent?: string
    /** Where a proposal stands, or `none` for committed work (nothing proposed, nor under a proposal). */
    proposal?: string
    /** Text in the id or title. */
    q?: string
}

interface Made { created_by: string, owned: number, created_at: string, updated_at: string }
interface ProjectRow extends Made {
    id: string, name: string, key: string, description: string | null, icon: string | null, icon_color: string | null, next_number: number, next_chunk: number,
    focus_prompt: string | null, chunk_prompt: string | null, instructions: string, muted: string
}
interface ChunkRow extends Made { project: string, id: string, title: string, summary: string | null, priority: Priority | null, position: number }
interface IssueRow extends Made {
    project: string, id: string, title: string, status: string, priority: Priority | null,
    assignee: string | null, labels: string, notes: string | null,
    parent: string | null, chunk: string | null, position: number, schedule: number | null,
    proposal: Proposal | null, decided_by: string | null, decided_at: string | null, decision_note: string | null
}
interface CommentRow extends Made { id: number, project: string, issue: string, body: string, asks: Asks | null, answered?: number }
interface EventRow { id: number, project: string, issue: string, field: ActivityField, before: string | null, after: string | null, created_by: string, owned: number, created_at: string }
interface DocRow extends Made { project: string, id: string, title: string, body: string, position: number }
interface SignalRow { id: number, project: string, issue: string | null, chunk: string | null, status: string | null, schedule: number | null, kind: 'focus' | 'comment' | 'message', note: string | null, target: string | null, delivered_to: string, instructions: string, created_by: string, owned: number, created_at: string }

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A named tint or any `#rrggbb`: the page's tint, a project icon's colour. */
const TINT: Field = {type: 'string', nullable: true, pattern: new RegExp(`^(${Object.keys(TINTS).join('|')}|#[0-9a-fA-F]{6})$`), hint: `use ${Object.keys(TINTS).join(', ')} or a colour like #3b82f6`}
const KEY = /^[A-Z][A-Z0-9]{0,9}$/

export const PROJECT_FIELDS: Record<string, Field> = {
    id: {type: 'string', pattern: SLUG, hint: 'use lowercase letters, digits and dashes'},
    name: {type: 'string', required: true},
    key: {type: 'string', pattern: KEY, hint: 'use capitals and digits, starting with a capital, e.g. LAR'},
    description: {type: 'string', nullable: true},
    icon: {type: 'string', nullable: true, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/, hint: "use a Heroicon's name, e.g. shopping-cart"},
    iconColor: TINT,
    /** The owner's: what the project's sessions hear when asked to focus (none is the Orrery's). */
    focusPrompt: {type: 'string', nullable: true},
    chunkPrompt: {type: 'string', nullable: true},
    instructions: {type: 'lines', nullable: true},
    /** Ids of the Orrery's standing instructions the project switches off. */
    muted: {type: 'strings', nullable: true},
}

/** What a project's sessions are told: only the owner changes it. */
const PROMPT_FIELDS = ['focusPrompt', 'chunkPrompt', 'instructions', 'muted']

// No `id` on chunks and issues: Orrery numbers them in their project (chunks 1, 2, …, issues KEY-1, …).
export const CHUNK_FIELDS: Record<string, Field> = {
    title: {type: 'string', required: true},
    summary: {type: 'string', nullable: true},
    priority: {type: 'string', values: PRIORITIES, nullable: true},
    position: {type: 'number'},
}

export const ISSUE_FIELDS: Record<string, Field> = {
    title: {type: 'string', required: true},
    /** A status's id, or a kind (`started` picks its first status); `doing` still means started. */
    status: {type: 'string'},
    /** Before statuses: with `status: "todo"` (or none), a plan puts it in Todo and null in Backlog. */
    plan: {type: 'string', values: LEGACY_PLANS, nullable: true},
    priority: {type: 'string', values: PRIORITIES, nullable: true},
    assignee: {type: 'string', nullable: true},
    labels: {type: 'strings', nullable: true},
    notes: {type: 'string', nullable: true},
    /** `pending` makes it a proposal (or puts one up again after changes); `null` commits it. The owner
     * decides on it with `decide`. */
    proposal: {type: 'string', values: ['pending'], nullable: true},
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

export const DECISION_FIELDS: Record<string, Field> = {
    decision: {type: 'string', values: DECISIONS, required: true},
    note: {type: 'string', nullable: true},
}

/** The comment a decision leaves on its proposal, for the session working on it to hear. */
const DECIDED: Record<Decision, string> = {approved: 'Approved this proposal.', changes: 'Asked for changes to this proposal.', rejected: 'Rejected this proposal.'}

export const SIGNAL_FIELDS: Record<string, Field> = {
    note: {type: 'string', nullable: true},
    /** A session id; left out, every session on the project gets it. */
    session: {type: 'string', nullable: true},
    /** The standing instructions to add, by id (the Orrery's or the project's); left out, those ticked by default. */
    instructions: {type: 'strings', nullable: true},
}

/** A chunk's focus can be narrowed to its issues of one open status: `{status: 'todo'}` (an id or a kind). */
export const CHUNK_SIGNAL_FIELDS: Record<string, Field> = {
    ...SIGNAL_FIELDS,
    status: {type: 'string', nullable: true},
}

export const STATUS_FIELDS: Record<string, Field> = {
    id: {type: 'string', pattern: SLUG, hint: 'use lowercase letters, digits and dashes'},
    name: {type: 'string', required: true},
    kind: {type: 'string', values: KINDS, required: true},
    color: {...TINT, nullable: false},
    position: {type: 'number'},
}

/** What agents sent before statuses, and what they mean now. */
const LEGACY_KINDS: Record<string, Kind> = {doing: 'started', now: 'todo', next: 'todo', later: 'todo'}

export const SETTINGS_FIELDS: Record<string, Field> = {
    tint: TINT,
    focusPrompt: {type: 'string', nullable: true},
    chunkPrompt: {type: 'string', nullable: true},
    instructions: {type: 'lines', nullable: true},
}

export const OWNER_FIELDS: Record<string, Field> = {
    name: {type: 'string', required: true},
}

/** An actor's id from a name: lowercase snake case, `Sköll Fenrisson` → `skoll_fenrisson`. */
export const actorId = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

export const COMMENT_FIELDS: Record<string, Field> = {
    body: {type: 'string', required: true},
    /** `decision` or `feedback`: the comment waits on the owner until they comment after it. */
    asks: {type: 'string', values: ASKS, nullable: true},
}

/** Whether the owner has commented on the issue since comment `c`. */
const ANSWERED = 'EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id) AS answered'

export class Store {
    constructor(
        readonly db: DatabaseSync,
        private readonly onChange: (project: string) => void = () => {},
        private readonly onSignal: (signal: Signal) => void = () => {},
        private readonly onNotice: (notice: Notice) => void = () => {},
        private readonly onSettings: (settings: Settings) => void = () => {},
        /** The owner's id until they give their name (what Orrery used before it asked). */
        private readonly unnamed = 'owner',
    ) {}

    /** The owner's id: what waits on them (a proposal, an agent's ask) is assigned to it. */
    private get owner() {
        return this.ownerOf().name
    }

    /** An assignee as stored: `owner` is the owner's id, whatever their name, so an agent needn't know it. */
    private assigneeOf(value: Input[string]): string | null | undefined {
        if (value === undefined) return undefined
        const name = String(value ?? '').trim()
        return name.toLowerCase() === 'owner' ? this.owner : name || null
    }

    /** The owner: their name as the page shows it, their `Orrery-Actor` id, and whether they've given it. */
    ownerOf(): Owner {
        const row = this.get<{value: string}>("SELECT value FROM settings WHERE key = 'owner'")
        const display = row ? String(JSON.parse(row.value)) : ''
        return display ? {name: actorId(display), display, named: true} : {name: this.unnamed, display: this.unnamed, named: false}
    }

    /** Names the owner: anyone may the first time (the page asks on first open), then only the owner. What
     * was theirs under the old id (what they made, what's assigned to them, their decisions) moves to the new one. */
    nameOwner(body: unknown, actor = AGENT): Owner {
        const before = this.ownerOf()
        if (before.named && !actor.owner) throw forbidden("Only the owner renames the owner; send Orrery-Actor: <owner>")
        const display = String(checkInput(body, OWNER_FIELDS).name).trim().slice(0, 60)
        const name = actorId(display)
        if (!name) throw badRequest('The name needs a letter or a digit in it')
        if (name === AGENT.name) throw badRequest(`"${AGENT.name}" is what requests without Orrery-Actor are; pick another name`)
        transaction(this.db, () => {
            this.run("INSERT INTO settings (key, value) VALUES ('owner', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(display))
            if (name === before.name) return
            for (const table of ['projects', 'chunks', 'issues', 'docs', 'comments', 'signals', 'schedules', 'issue_events'])
                this.run(`UPDATE ${table} SET created_by = ? WHERE owned = 1 AND lower(created_by) = ?`, name, before.name)
            this.run('UPDATE issues SET assignee = ? WHERE lower(assignee) = ?', name, before.name)
            this.run('UPDATE issues SET decided_by = ? WHERE lower(decided_by) = ?', name, before.name)
        })
        if (name !== before.name) for (const {id} of this.all<{id: string}>('SELECT id FROM projects')) this.onChange(id)
        return this.ownerOf()
    }

    /** Agents' latest comments across projects (what the bell shows), newest first, after the ones still
     * waiting on the owner (a decision or feedback they haven't answered). */
    /** The bell's notices: the latest `limit` (all of them when null), and with `cleared` the cleared ones
     * too (marked so), as the notifications page lists them. */
    notices(limit: number | null = 30, cleared = false): Notice[] {
        return this.all<CommentRow & {title: string, cleared: number}>(`
            SELECT * FROM (
                SELECT c.*, i.title, ${ANSWERED} FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue
                WHERE c.owned = 0 ${cleared ? '' : 'AND c.cleared = 0'})
            ORDER BY (asks IS NOT NULL AND answered = 0) DESC, created_at DESC, id DESC LIMIT ?`, limit ?? -1)
            .map(row => ({...commentOf(row), project: row.project, title: row.title, ...row.cleared ? {cleared: true} : {}}))
    }

    /** Takes notices out of the bell (the comments stay on their issues): those in `ids`, or all made at
     * or before `before`. Says how many. */
    clearNotices(body: unknown): number {
        const {ids, before} = (body ?? {}) as {ids?: unknown, before?: unknown}
        if (Array.isArray(ids) && ids.every(id => Number.isInteger(id)) && ids.length) {
            return Number(this.run(`UPDATE comments SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND id IN (${ids.map(() => '?').join(', ')})`, ...ids as number[]).changes)
        }
        if (typeof before === 'string' && before) {
            // Not the ones still waiting on the owner: those go when they're answered, or one by one.
            return Number(this.run(`UPDATE comments AS c SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND created_at <= ?
                AND (asks IS NULL OR EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id))`, before).changes)
        }
        throw badRequest('Send "ids" (comment ids) or "before" (a time) to clear')
    }

    // Projects

    listProjects(): ProjectSummary[] {
        return this.all<ProjectRow>('SELECT * FROM projects ORDER BY name COLLATE NOCASE').map(row => {
            const {board, ...project} = this.projectOf(row)
            return {...project, counts: board.counts, kinds: board.kinds, chunks: board.chunks.filter(c => c.id).length}
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
        this.promptsAreTheOwners(input, actor)
        const name = String(input.name).trim()
        const id = input.id ? String(input.id) : slugify(name)
        if (!SLUG.test(id)) throw badRequest(`"${name}" doesn't make an id; give one in "id"`)
        if (this.get('SELECT 1 FROM projects WHERE id = ?', id)) throw conflict(`There is already a project "${id}"`)
        const key = input.key ? String(input.key) : keyFor(name)
        const now = stamp()
        this.run('INSERT INTO projects (id, name, key, description, icon, icon_color, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            id, name, key, nullable(input.description), nullable(input.icon), nullable(input.iconColor), actor.name, Number(actor.owner), now, now)
        this.update('projects', 'id = ?', [id], this.promptColumns(input))
        this.onChange(id)
        return this.project(id)
    }

    updateProject(id: string, body: unknown, actor = AGENT): Project {
        this.projectRow(id)
        const input = checkInput(body, PROJECT_FIELDS, true)
        this.promptsAreTheOwners(input, actor)
        if (input.id !== undefined && input.id !== id) throw badRequest("A project's id can't change")
        this.update('projects', 'id = ?', [id], {
            name: input.name === undefined ? undefined : String(input.name).trim(),
            key: input.key,
            description: input.description,
            icon: input.icon,
            icon_color: input.iconColor,
            ...this.promptColumns(input),
        })
        this.onChange(id)
        return this.project(id)
    }

    private promptsAreTheOwners(input: Input, actor: Actor) {
        const sent = PROMPT_FIELDS.filter(key => input[key] !== undefined)
        if (sent.length && !actor.owner) throw forbidden(`Only the owner changes what sessions are told (${sent.join(', ')}); send Orrery-Actor: <owner>`)
    }

    /** The prompt fields as columns: an empty template is none (the Orrery's). */
    private promptColumns(input: Input): Input {
        const template = (value: Input[string]) => value === undefined ? undefined : String(value ?? '').trim() || null
        const list = (value: Input[string]) => value === undefined ? undefined : JSON.stringify(value ?? [])
        return {focus_prompt: template(input.focusPrompt), chunk_prompt: template(input.chunkPrompt), instructions: list(input.instructions), muted: list(input.muted)}
    }

    /** The templates the project's sessions hear: its own, else the Orrery's, else the defaults. */
    prompts(project: string): {focus: string, chunk: string} {
        const row = this.projectRow(project)
        const settings = this.settings()
        return {
            focus: row.focus_prompt ?? settings.focusPrompt ?? DEFAULT_FOCUS_PROMPT,
            chunk: row.chunk_prompt ?? settings.chunkPrompt ?? DEFAULT_CHUNK_PROMPT,
        }
    }

    /** The texts of the standing instructions for a focus: those named by id, or else the ones ticked by default. */
    private instructionsFor(project: string, ids: Input[string]): string[] {
        const row = this.projectRow(project)
        const global = this.settings().instructions
        const own = JSON.parse(row.instructions) as Instruction[]
        if (ids === undefined || ids === null) return defaultInstructions(global, own, JSON.parse(row.muted) as string[]).map(i => i.text)
        const all = [...global, ...own]
        const unknown = (ids as string[]).filter(id => !all.some(i => i.id === id))
        if (unknown.length) throw badRequest(`No standing instruction ${unknown.join(', ')}; the Orrery's and ${project}'s are ${all.map(i => i.id).join(', ') || 'none'}`)
        return all.filter(i => (ids as string[]).includes(i.id)).map(i => i.text)
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
            this.run('DELETE FROM schedules WHERE project = ?', id)
            this.run('DELETE FROM projects WHERE id = ?', id)
        })
        this.onChange(id)
    }

    /** This Orrery's own settings. */
    settings(): Settings {
        const rows = this.all<{key: string, value: string}>('SELECT key, value FROM settings')
        const value = (key: string) => {
            const row = rows.find(r => r.key === key)
            return row ? JSON.parse(row.value) as unknown : undefined
        }
        return {
            tint: (value('tint') as string | undefined) ?? null,
            statuses: this.statuses(),
            focusPrompt: (value('focusPrompt') as string | undefined) || null,
            chunkPrompt: (value('chunkPrompt') as string | undefined) || null,
            instructions: (value('instructions') as Instruction[] | undefined) ?? [],
        }
    }

    // Statuses

    /** The issue statuses, in board order: by kind, then as arranged. */
    statuses(): IssueStatus[] {
        const rows = this.all<IssueStatus>('SELECT id, name, kind, color, position FROM statuses ORDER BY position, id')
        return KINDS.flatMap(kind => rows.filter(r => r.kind === kind))
    }

    /** A new status, the owner's to add: `{name, kind, color?, id?, position?}`. */
    createStatus(body: unknown, actor = AGENT): IssueStatus {
        this.ownerOnly(actor, 'statuses')
        const input = checkInput(body, {...STATUS_FIELDS, color: {...STATUS_FIELDS.color!, required: false}})
        const name = String(input.name).trim()
        const id = input.id ? String(input.id) : slugify(name)
        if (!SLUG.test(id)) throw badRequest(`"${name}" doesn't make an id; give one in "id"`)
        if (id === 'proposed') throw badRequest('"proposed" is where proposals sit; give the status another id')
        if (this.get('SELECT 1 FROM statuses WHERE id = ?', id)) throw conflict(`There is already a status "${id}"`)
        const position = input.position ?? (this.get<{n: number | null}>('SELECT max(position) AS n FROM statuses')?.n ?? 0) + 1
        this.run('INSERT INTO statuses (id, name, kind, color, position) VALUES (?, ?, ?, ?, ?)', id, name, String(input.kind), String(input.color ?? 'slate'), Number(position))
        this.statusesChanged()
        return this.status(id)
    }

    /** Renames, recolours or moves a status, or gives it another kind (not the last of its kind). */
    updateStatus(id: string, body: unknown, actor = AGENT): IssueStatus {
        this.ownerOnly(actor, 'statuses')
        const before = this.status(id)
        const input = checkInput(body, STATUS_FIELDS, true)
        if (input.id !== undefined && input.id !== id) throw badRequest("A status's id can't change; rename it with \"name\"")
        if (input.kind !== undefined && input.kind !== before.kind) this.keepOneOf(before)
        this.run('UPDATE statuses SET name = coalesce(?, name), kind = coalesce(?, kind), color = coalesce(?, color), position = coalesce(?, position) WHERE id = ?',
            input.name === undefined ? null : String(input.name).trim(), nullable(input.kind), nullable(input.color), input.position === undefined ? null : Number(input.position), id)
        this.statusesChanged()
        return this.status(id)
    }

    /** Removes a status; its issues and schedules move to `into` (another status), which it needs when it has any. */
    deleteStatus(id: string, into: string | undefined, actor = AGENT) {
        this.ownerOnly(actor, 'statuses')
        const status = this.status(id)
        this.keepOneOf(status)
        const used = this.get<{n: number}>('SELECT (SELECT count(*) FROM issues WHERE status = ?) + (SELECT count(*) FROM schedules WHERE place = ?) AS n', id, id)!.n
        if (into !== undefined) this.status(into)
        if (into === id) throw badRequest('Move its issues to another status')
        if (used && !into) throw conflict(`${used} issues or schedules are in ${status.name}; say which status they move to with ?into=`)
        transaction(this.db, () => {
            if (into) {
                this.run('UPDATE issues SET status = ? WHERE status = ?', into, id)
                this.run('UPDATE schedules SET place = ? WHERE place = ?', into, id)
                this.run('UPDATE signals SET status = ? WHERE status = ?', into, id)
            }
            this.run('DELETE FROM statuses WHERE id = ?', id)
        })
        this.statusesChanged()
    }

    status(id: string): IssueStatus {
        const found = this.statuses().find(s => s.id === id)
        if (!found) throw notFound(`No status "${id}"`)
        return found
    }

    /** The status an issue gets from what was sent: a status's id, a kind (its first status), or the words
     * from before statuses (`doing`; `todo` with a `plan`). */
    resolveStatus(status: Input[string], plan?: Input[string]): string {
        const statuses = this.statuses()
        const first = (kind: Kind) => statuses.find(s => s.kind === kind)!.id
        if (plan !== undefined && (status === undefined || status === 'todo')) return first(plan ? 'todo' : 'backlog')
        if (status === undefined) return first('backlog')
        const text = String(status)
        if (statuses.some(s => s.id === text)) return text
        if (KINDS.includes(text as Kind)) return first(text as Kind)
        if (LEGACY_KINDS[text]) return first(LEGACY_KINDS[text])
        throw badRequest(`"status" is "${text}", not one of ${statuses.map(s => s.id).join(', ')} (or a kind: ${KINDS.join(', ')})`)
    }

    /** What a status filter or focus means: the status ids it covers (an id, a kind, or an old word). */
    private statusIds(status: string): string[] {
        const statuses = this.statuses()
        if (statuses.some(s => s.id === status)) return [status]
        const kind = (KINDS.includes(status as Kind) ? status : LEGACY_KINDS[status]) as Kind | undefined
        return kind ? statuses.filter(s => s.kind === kind).map(s => s.id) : []
    }

    private keepOneOf(status: IssueStatus) {
        if (this.statuses().filter(s => s.kind === status.kind).length === 1) throw conflict(`${status.name} is the only ${status.kind} status; add another before it goes`)
    }

    private ownerOnly(actor: Actor, what: string) {
        if (!actor.owner) throw forbidden(`Only the owner changes the ${what}; send Orrery-Actor: <owner>`)
    }

    /** Every board is drawn again with them, and the page gets the new list with the settings. */
    private statusesChanged() {
        this.onSettings(this.settings())
        for (const {id} of this.all<{id: string}>('SELECT id FROM projects')) this.onChange(id)
    }

    /** The owner's to change: they're how the Orrery looks to them. */
    updateSettings(body: unknown, actor = AGENT): Settings {
        if (!actor.owner) throw forbidden("Only the owner changes the Orrery's settings; send Orrery-Actor: <owner>")
        const input = checkInput(body, SETTINGS_FIELDS, true)
        transaction(this.db, () => {
            for (const [key, sent] of Object.entries(input)) {
                if (sent === undefined) continue
                // An empty template is none: the default.
                const value = (key === 'focusPrompt' || key === 'chunkPrompt') && typeof sent === 'string' ? sent.trim() || null : sent
                this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
            }
        })
        const settings = this.settings()
        this.onSettings(settings)
        return settings
    }

    /** Tells the page the project changed, after a write made outside the store (a schedule marking its issue). */
    changed(project: string) {
        this.onChange(project)
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

    /** Its issues stay, in no chunk. */
    deleteChunk(project: string, id: string, actor = AGENT) {
        id = this.chunkId(project, id)
        const row = this.chunkRow(project, id)
        this.refuse(actor, `Deleting chunk "${id}"`, row.owned ? [`chunk "${id}"`] : [])
        transaction(this.db, () => {
            this.run('UPDATE issues SET chunk = NULL WHERE project = ? AND chunk = ?', project, id)
            this.run('DELETE FROM chunk_aliases WHERE project = ? AND chunk = ?', project, id)
            this.run('DELETE FROM signals WHERE project = ? AND chunk = ?', project, id)
            // Schedules that made issues in it make them in no chunk from now on.
            this.run('UPDATE schedules SET chunk = NULL WHERE project = ? AND chunk = ?', project, id)
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
        const statuses = filter.status ? this.statusIds(filter.status) : []
        const columns = filter.column === 'proposed' ? ['proposed'] : filter.column ? this.statusIds(filter.column) : []
        return records.filter(r =>
            (!filter.status || statuses.includes(r.status))
            && (!filter.priority || (filter.priority === 'none' ? !r.priority : r.priority === filter.priority))
            && (!filter.column || columns.includes(r.column))
            && (!filter.assignee || (filter.assignee === 'none' ? !r.assignee : r.assignee === this.assigneeOf(filter.assignee)))
            && (!filter.label || r.labels.includes(filter.label))
            && (!filter.chunk || (filter.chunk === 'none' ? !r.chunk : r.chunk === filter.chunk))
            && (!filter.parent || (filter.parent === 'none' ? !r.parent : r.parent === filter.parent))
            && (!filter.proposal || (filter.proposal === 'none' ? r.column !== 'proposed' : r.proposal === filter.proposal))
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
            this.run(`INSERT INTO issues (project, id, title, status, priority, assignee, labels, notes, proposal, parent, chunk, position,
                                          created_by, owned, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, id, String(input.title).trim(), this.resolveStatus(input.status, input.plan), nullable(input.priority),
                // A proposal waits on the owner, so it's theirs, whoever the request names.
                input.proposal === 'pending' ? this.owner : nullable(this.assigneeOf(input.assignee)),
                JSON.stringify(input.labels ?? []), nullable(input.notes), nullable(input.proposal),
                parent, chunk, Number(input.position ?? this.nextPosition('issues', project)), actor.name, Number(actor.owner), now, now)
            this.record(project, id, actor, [['created', null, null]])
            this.touchProject(project)
            return id
        })
        this.onChange(project)
        return this.issue(project, id)
    }

    /** `parent: null` lifts a sub-issue to the top, into the chunk it was in unless `chunk` says otherwise.
     * `project` moves it (with its sub-issues and comments) to the top of another project. `proposal:
     * null` commits a proposal: an agent can only commit one the owner approved. */
    updateIssue(project: string, id: string, body: unknown, actor = AGENT): IssueDetail {
        id = this.issueId(project, id)
        this.issueRow(project, id)
        const input = checkInput(body, ISSUE_FIELDS, true)
        if (input.project !== undefined && input.project !== project) {
            const {project: to, parent, chunk, ...rest} = input
            const moved = this.moveIssue(project, id, String(to), parent ?? null, chunk ?? null, actor)
            return this.updateIssue(String(to), moved, rest, actor)
        }
        const row = this.issueRow(project, id)
        if (input.proposal === null && row.proposal && row.proposal !== 'approved' && !actor.owner) {
            throw forbidden(`Committing ${id} is the owner's call until they approve it: it's ${row.proposal === 'pending' ? 'waiting on them' : row.proposal === 'changes' ? 'waiting on changes' : 'rejected'}`)
        }

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

        const title = input.title === undefined ? undefined : String(input.title).trim()
        const status = input.status === undefined && input.plan === undefined ? undefined : this.resolveStatus(input.status, input.plan)
        const assignee = input.proposal === 'pending' ? this.owner : this.assigneeOf(input.assignee)
        const labels = input.labels === undefined ? undefined : JSON.stringify(input.labels ?? [])
        const moved = input.parent !== undefined && parent !== row.parent
        transaction(this.db, () => {
            this.record(project, id, actor, [
                ['title', row.title, title],
                ['status', row.status, status],
                ['priority', row.priority, input.priority],
                ['assignee', row.assignee, assignee],
                ['labels', row.labels, labels],
                ['notes', row.notes, input.notes],
                ['proposal', row.proposal, input.proposal],
                // A sub-issue is in its parent's chunk, so a new parent says it all.
                moved ? ['parent', row.parent, parent] : ['chunk', row.chunk, chunk],
            ])
            this.update('issues', 'project = ? AND id = ?', [project, id], {
                title,
                status,
                priority: input.priority,
                assignee,
                labels,
                notes: input.notes,
                proposal: input.proposal,
                // Put up again, it waits on a new decision.
                ...input.proposal === 'pending' ? {decided_by: null, decided_at: null, decision_note: null} : {},
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

    /** The owner's decision on a proposal: approved (still not work until it's committed), changes asked
     * for, or rejected. It's kept on the issue and left as their comment, so the session on it hears, and
     * the issue goes back to the agent who proposed it. */
    decide(project: string, id: string, body: unknown, actor = AGENT): IssueDetail {
        id = this.issueId(project, id)
        const row = this.issueRow(project, id)
        if (!actor.owner) throw forbidden(`Deciding on ${id} is the owner's call; send Orrery-Actor: <owner>`)
        if (!row.proposal) throw badRequest(`${id} isn't a proposal; make it one with PATCH {"proposal": "pending"}`)
        const input = checkInput(body ?? {}, DECISION_FIELDS)
        const decision = input.decision as Decision
        const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null
        const assignee = row.owned ? row.assignee : row.created_by
        transaction(this.db, () => {
            this.run('UPDATE issues SET proposal = ?, decided_by = ?, decided_at = ?, decision_note = ?, assignee = ? WHERE project = ? AND id = ?',
                decision, actor.name, stamp(), note, assignee, project, id)
            this.record(project, id, actor, [['proposal', row.proposal, decision], ['assignee', row.assignee, assignee]])
        })
        this.createComment(project, id, {body: note ? `${DECIDED[decision]}\n\n${note}` : DECIDED[decision]}, actor)
        return this.issue(project, id)
    }

    /** Moves an issue and everything under it to `to`, where they get its ids (KEY-n); the ids they had
     * stay as aliases there. Says the issue's new id. */
    private moveIssue(from: string, id: string, to: string, parent: Input[string], chunk: Input[string], actor: Actor): string {
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
            for (const [old, next] of names) this.run('UPDATE issue_events SET project = ?, issue = ? WHERE project = ? AND issue = ?', to, next, from, old)
            this.record(to, names.get(id)!, actor, [['project', from, to]])
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
        return this.all<CommentRow>(`SELECT c.*, ${ANSWERED} FROM comments c WHERE project = ? AND issue = ? ORDER BY created_at, id`, project, issue).map(commentOf)
    }

    /** Who changed what on the issue, and when, oldest first. */
    listActivity(project: string, issue: string): IssueEvent[] {
        issue = this.issueId(project, issue)
        this.issueRow(project, issue)
        return this.all<EventRow>('SELECT * FROM issue_events WHERE project = ? AND issue = ? ORDER BY created_at, id', project, issue).map(eventOf)
    }

    comment(project: string, issue: string, id: number): Comment {
        issue = this.issueId(project, issue)
        return commentOf(this.commentRow(project, issue, id))
    }

    /** An agent's ask assigns the issue to the owner; the owner's answer gives it back to the agent who asked. */
    createComment(project: string, issue: string, body: unknown, actor = AGENT): Comment {
        issue = this.issueId(project, issue)
        const row = this.issueRow(project, issue)
        const input = checkInput(body, COMMENT_FIELDS)
        const now = stamp()
        const asker = actor.owner && row.assignee === this.owner
            ? this.get<{created_by: string}>(`SELECT c.created_by FROM comments c WHERE c.project = ? AND c.issue = ? AND c.asks IS NOT NULL AND c.owned = 0
                AND NOT EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id)
                ORDER BY c.id DESC LIMIT 1`, project, issue)?.created_by
            : undefined
        const assignee = !actor.owner && input.asks ? this.owner : asker
        const id = transaction(this.db, () => {
            const {lastInsertRowid} = this.run('INSERT INTO comments (project, issue, body, asks, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                project, issue, String(input.body), nullable(input.asks), actor.name, Number(actor.owner), now, now)
            if (assignee) {
                this.run('UPDATE issues SET assignee = ? WHERE project = ? AND id = ?', assignee, project, issue)
                this.record(project, issue, actor, [['assignee', row.assignee, assignee]])
            }
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
            this.update('comments', 'id = ?', [id], {body: input.body, asks: input.asks})
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
        const instructions = JSON.stringify(this.instructionsFor(project, input.instructions))
        const {lastInsertRowid} = this.run('INSERT INTO signals (project, issue, kind, note, target, instructions, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            project, issue, 'focus', nullable(input.note), nullable(input.session), instructions, actor.name, Number(actor.owner), stamp())
        const signal = signalOf(this.get<SignalRow>('SELECT * FROM signals WHERE id = ?', Number(lastInsertRowid))!)
        this.onSignal(signal)
        return signal
    }

    /** Asks the sessions (or `session`) to work through the chunk's open issues now, or (`status`) its issues of
     * that status; `none` is the issues in no chunk. */
    focusChunk(project: string, chunk: string, body: unknown, actor = AGENT): Signal {
        this.projectRow(project)
        if (chunk !== 'none') {
            chunk = this.chunkId(project, chunk)
            this.chunkRow(project, chunk)
        }
        const input = checkInput(body ?? {}, CHUNK_SIGNAL_FIELDS)
        if (input.status) {
            const status = String(input.status)
            const ids = this.statusIds(status)
            const statuses = this.statuses().filter(s => ids.includes(s.id))
            if (!statuses.length || statuses.some(s => CLOSED.includes(s.kind))) {
                throw badRequest(`"status" is "${status}", not an open status (${this.statuses().filter(s => !CLOSED.includes(s.kind)).map(s => s.id).join(', ')}) or kind (backlog, todo, started)`)
            }
        }
        const instructions = JSON.stringify(this.instructionsFor(project, input.instructions))
        const {lastInsertRowid} = this.run('INSERT INTO signals (project, chunk, status, kind, note, target, instructions, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            project, chunk, nullable(input.status), 'focus', nullable(input.note), nullable(input.session), instructions, actor.name, Number(actor.owner), stamp())
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

    /** Sends a schedule's message to the project's sessions: about no issue, as the schedule's maker. */
    message(project: string, schedule: number, text: string, actor = AGENT): Signal {
        this.projectRow(project)
        const {lastInsertRowid} = this.run('INSERT INTO signals (project, schedule, kind, note, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            project, schedule, 'message', text, actor.name, Number(actor.owner), stamp())
        const signal = signalOf(this.get<SignalRow>('SELECT * FROM signals WHERE id = ?', Number(lastInsertRowid))!)
        this.onSignal(signal)
        return signal
    }

    /** The owner's scheduled asks and messages from the last day that no session has heard yet: the next
     * one to connect gets them. */
    unheardScheduled(project: string): Signal[] {
        const since = new Date(Date.now() - 86_400_000).toISOString()
        return this.all<SignalRow>(`
            SELECT s.* FROM signals s LEFT JOIN issues i ON i.project = s.project AND i.id = s.issue
            WHERE s.project = ? AND s.owned = 1 AND s.delivered_to = '[]' AND s.created_at >= ?
              AND ((s.kind = 'focus' AND i.schedule IS NOT NULL AND i.status NOT IN (SELECT id FROM statuses WHERE kind IN ('done', 'canceled'))) OR s.kind = 'message')
            ORDER BY s.id`, project, since).map(signalOf)
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
            this.run(`INSERT INTO issues (project, id, title, status, priority, assignee, labels, notes, parent, chunk, position,
                                          created_by, owned, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, task.id, task.title, this.resolveStatus(legacyStatus(task.status, task.plan)), task.priority ?? null, task.assignee ?? null, JSON.stringify(task.labels),
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
            icon: row.icon ?? undefined,
            iconColor: row.icon_color ?? undefined,
            focusPrompt: row.focus_prompt ?? undefined,
            chunkPrompt: row.chunk_prompt ?? undefined,
            instructions: JSON.parse(row.instructions) as Instruction[],
            muted: JSON.parse(row.muted) as string[],
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
            notes: row.notes ?? undefined,
            proposal: row.proposal ?? undefined,
            decidedBy: row.decided_by ?? undefined,
            decidedAt: row.decided_at ?? undefined,
            decisionNote: row.decision_note ?? undefined,
            comments: comments.get(row.id) ?? 0,
            aliases: issueAliases.get(row.id) ?? [],
            schedule: row.schedule ?? undefined,
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
        return buildBoard({chunks: grouped}, this.statuses())
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

    /** Notes the fields that change: `after` undefined is left as it is, and a value equal to `before` is no
     * change. `created` is always noted. Notes keep no values, only that they changed. */
    private record(project: string, issue: string, actor: Actor, changes: [ActivityField, string | null, Input[string]][]) {
        const now = stamp()
        for (const [field, before, after] of changes) {
            if (field !== 'created' && (after === undefined || (after ?? null) === before)) continue
            const [from, to] = field === 'notes' ? [null, null] : [before, nullable(after)]
            this.run('INSERT INTO issue_events (project, issue, field, before, after, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                project, issue, field, from, to, actor.name, Number(actor.owner), now)
        }
    }

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
    return {
        id: row.id, issue: row.issue, body: row.body, asks: row.asks ?? undefined, answered: row.asks ? !!row.answered : undefined,
        createdBy: row.created_by, protected: !!row.owned, createdAt: row.created_at, updatedAt: row.updated_at,
    }
}

function eventOf(row: EventRow): IssueEvent {
    return {
        id: row.id, issue: row.issue, field: row.field, before: row.before ?? undefined, after: row.after ?? undefined,
        createdBy: row.created_by, protected: !!row.owned, createdAt: row.created_at,
    }
}

function signalOf(row: SignalRow): Signal {
    return {
        id: row.id, project: row.project, issue: row.issue ?? undefined, chunk: row.chunk ?? undefined, status: row.status ?? undefined, schedule: row.schedule ?? undefined, kind: row.kind, note: row.note ?? undefined,
        target: row.target ?? undefined, deliveredTo: JSON.parse(row.delivered_to) as string[], instructions: JSON.parse(row.instructions) as string[], createdBy: row.created_by, protected: !!row.owned, createdAt: row.created_at,
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

/** Three capitals from the name, e.g. `LAR` for Larder. */
function keyFor(name: string): string {
    const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '')
    return letters.slice(0, 3) || 'ISS'
}
