// Projects, chunks, issues and comments: reading and changing them, and the rules they keep.
// Issues nest (a parent holds sub-issues, to any depth); only a top-level issue is in a chunk, its
// sub-issues are in the same one. Every change ends with `onChange(project)`, which the server
// turns into a server-sent event, so open pages update.
import {randomBytes} from 'node:crypto'
import type {ActivityField, Asks, Board, Choice, Chunk, Comment, Counts, Decision, Doc, DocSummary, Issue, IssueEvent, IssueStatus, Kind, Kinds, Notice, NoticeList, Owner, Picks, Preset, Priority, Project, Proposal, Release, ReleaseMode, SessionWork, Settings, Signal, Starts, Upload} from '#shared/roadmap'
import {ASKS, CLOSED, DECISIONS, KINDS, NOTICE_LISTS, PRIORITIES, RELEASE_MODES, TINTS, emptyKinds, issueRef, keyFor, slugify} from '#shared/roadmap'
import type {Field, Input} from './input'
import {badRequest, checkInput, conflict, forbidden, isObject, notFound} from './input'
import {describePicks, parseChoices, resolvePicks} from './choices'
import type {IssueInput, RoadmapFile, TaskFile} from './roadmap'
import {LEGACY_PLANS, buildBoard, legacyStatus} from './roadmap'
import type {Db, Value} from './database'
import type {Instruction} from '#shared/prompt'
import {DEFAULT_CHUNK_PROMPT, DEFAULT_FOCUS_PROMPT, defaultInstructions} from '#shared/prompt'
import {UPSERT_ISSUE_ALIAS, renumber} from './renumber'

/** A project without its board, as `GET /api/projects` lists it. */
export interface ProjectSummary extends Omit<Project, 'board'> {
    counts: Counts
    kinds: Kinds
    chunks: number
}

/** A release with its issues: `tasks` the project's own, and `projects` each project's part (those drawing on it
 * too, when it's their source). */
export interface ReleaseDetail extends Release {
    project: string
    tasks: Issue[]
    projects: {project: string, name: string, issues: number, kinds: Kinds, tasks: Issue[]}[]
}

/** An issue on its own: where it sits, and its sub-issues by id. */
export interface IssueRecord extends Omit<Issue, 'tasks'> {
    project: string
    /** What says whose board it's on, for commit bodies and PR descriptions: `orrery-<handle>: <id>`. */
    ref?: string
    parent: string | null
    /** The chunk it's in, a sub-issue's being its top-level issue's. */
    chunk: string | null
    sub_issues: string[]
}

/** What became of one issue in a change to many: done, or why not. */
export interface BulkResult {
    id: string
    ok: boolean
    error?: string
}

/** What one change to many issues can set. */
const BULK_FIELDS = ['status', 'priority', 'assignee', 'chunk', 'release']

/** An issue with its sub-issues drawn out, as `GET …/issues/:issue` shows it. */
export interface IssueDetail extends Issue {
    project: string
    ref: string
    parent: string | null
    chunk: string | null
}

export interface ChunkRecord extends Omit<Chunk, 'tasks'> {
    project: string
    position: number
    created_at: string
    updated_at: string
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
    /** A team task's id or URL: the issues linked to it. */
    external?: string
    chunk?: string
    /** A release's version, or `none` for issues set for none. */
    release?: string
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
    focus_prompt: string | null, chunk_prompt: string | null, instructions: string, muted: string, starts: string | null, repo: string | null,
    release_mode: ReleaseMode, releases_from: string | null
}
interface ChunkRow extends Made { project: string, id: string, title: string, summary: string | null, priority: Priority | null, position: number }
interface IssueRow extends Made {
    project: string, id: string, title: string, status: string, priority: Priority | null,
    assignee: string | null, labels: string, external: string, notes: string | null,
    parent: string | null, chunk: string | null, position: number, schedule: number | null,
    proposal: Proposal | null, decided_by: string | null, decided_at: string | null, decision_note: string | null,
    choices: string, picks: string | null, explore: string | null, ships_in: string | null
}
interface CommentRow extends Made { id: number, project: string, issue: string, body: string, asks: Asks | null, answered?: number }
interface EventRow { id: number, project: string, issue: string, field: ActivityField, before: string | null, after: string | null, created_by: string, owned: number, created_at: string }
interface DocRow extends Made { project: string, id: string, title: string, body: string, position: number }
interface ReleaseRow extends Made { project: string, version: string, branch: string | null, notes: string | null, shipped_on: string | null, position: number }
interface PresetRow { id: number, project: string | null, name: string, text: string, created_at: string, updated_at: string }
interface SignalRow { id: number, project: string, issue: string | null, chunk: string | null, status: string | null, release: string | null, schedule: number | null, kind: 'focus' | 'comment' | 'message', note: string | null, target: string | null, delivered_to: string, instructions: string, created_by: string, owned: number, created_at: string }

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A named tint or any `#rrggbb`: the page's tint, a project icon's colour. */
const TINT: Field = {type: 'string', nullable: true, pattern: new RegExp(`^(${Object.keys(TINTS).join('|')}|#[0-9a-fA-F]{6})$`), hint: `use ${Object.keys(TINTS).join(', ')} or a colour like #3b82f6`}
const KEY = /^[A-Z][A-Z0-9]{0,9}$/
/** A release's version: `1.0.0`, `1.0.0-rc.2`, `2026.10`, `v2`; it goes in URLs as it is. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/

export const PROJECT_FIELDS: Record<string, Field> = {
    id: {type: 'string', pattern: SLUG, hint: 'use lowercase letters, digits and dashes'},
    name: {type: 'string', required: true},
    key: {type: 'string', pattern: KEY, hint: 'use capitals and digits, starting with a capital, e.g. LAR'},
    description: {type: 'string', nullable: true},
    icon: {type: 'string', nullable: true, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/, hint: "use a Heroicon's name, e.g. shopping-cart"},
    icon_color: TINT,
    /** The owner's: what the project's sessions hear when asked to focus (none is the Orrery's). */
    focus_prompt: {type: 'string', nullable: true},
    chunk_prompt: {type: 'string', nullable: true},
    instructions: {type: 'lines', nullable: true},
    /** Ids of the Orrery's standing instructions the project switches off. */
    muted: {type: 'strings', nullable: true},
    repo: {type: 'string', nullable: true, pattern: /^https?:\/\/\S+[^/\s]$/, hint: 'use the web address of its code, e.g. https://github.com/you/shop'},
    /** Whether it has releases: none (a new project's), its own, or `shared`, those of `releases_from`. */
    release_mode: {type: 'string', values: RELEASE_MODES},
    /** Another project whose releases it ships in (a monorepo's apps going out together); sending it makes the
     * project `shared`, and null gives it its own. */
    releases_from: {type: 'string', nullable: true, pattern: SLUG, hint: "use the other project's id"},
}

/** `{limit, minutes}`, each a whole number from 1 (minutes up to a day), as the JSON to store. */
function parseStarts(value: unknown): string {
    const {limit, minutes, idle_minutes, ...rest} = (isObject(value) ? value : {})
    const whole = (n: unknown, most: number) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= most
    const maybe = (n: unknown) => n === undefined || n === null || whole(n, 24 * 60)
    if (Object.keys(rest).length || !whole(limit, 20) || !maybe(minutes) || !maybe(idle_minutes)) {
        throw new Error(`should be {limit, minutes?, idle_minutes?}: at most 20 sessions at once, each for 1 to 1440 minutes or until stopped, and stopped after 1 to 1440 idle minutes or never, not ${JSON.stringify(value)}`)
    }
    return JSON.stringify({limit, ...minutes ? {minutes} : {}, ...idle_minutes ? {idle_minutes} : {}})
}

/** What a project's sessions are told: only the owner changes these. */
const PROMPT_FIELDS = ['focus_prompt', 'chunk_prompt', 'instructions', 'muted']

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
    /** Its tasks on the team's tracker: ids (`CIR-1567`) or full URLs. */
    external: {type: 'strings', nullable: true},
    notes: {type: 'string', nullable: true},
    /** `pending` makes it a proposal (or puts one up again); `null` commits it, the owner's to do. The owner
     * decides on it with `decide`, and approving commits it. */
    proposal: {type: 'string', values: ['pending'], nullable: true},
    /** A proposal's choices for the owner: `[{key, question, pick: one|any, options: [{key, title, body?}], recommended?, from?}]`. */
    choices: {type: 'json', nullable: true, parse: parseChoices},
    /** Only on an update: moves the issue, its sub-issues and their comments to another project. */
    project: {type: 'string', pattern: SLUG, hint: "use the other project's id"},
    parent: {type: 'string', nullable: true},
    chunk: {type: 'string', nullable: true},
    /** The version of a release it ships in; null takes it out of one. */
    release: {type: 'string', nullable: true},
    position: {type: 'number'},
}

// A release's version is its id, given when it's made, and doesn't change. `position` is where it goes in the
// project's releases, from 0 at the top; a new one goes on top.
export const RELEASE_FIELDS: Record<string, Field> = {
    position: {type: 'number'},
    version: {type: 'string', required: true, pattern: VERSION, hint: 'use letters, digits, dots and dashes, e.g. 1.0.0-rc.2'},
    branch: {type: 'string', nullable: true},
    notes: {type: 'string', nullable: true},
    shipped_on: {type: 'string', nullable: true, pattern: /^\d{4}-\d{2}-\d{2}$/, hint: 'use a day, YYYY-MM-DD'},
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
    /** Approving a proposal with choices: the options picked, choice → options; a choice left out takes its recommendation. */
    picks: {type: 'json', parse: parsePicks},
    /** Asking for changes: the option to go further down, `{choice, option}`. */
    explore: {type: 'json', parse: parseExplore},
}

function parsePicks(value: unknown): string {
    if (!isObject(value)) throw new Error('should be {choice: [options]}')
    for (const [key, picked] of Object.entries(value)) {
        if (!Array.isArray(picked) || picked.some(p => typeof p !== 'string')) throw new Error(`${key} should be a list of option keys`)
    }
    return JSON.stringify(value)
}

function parseExplore(value: unknown): string {
    if (!isObject(value)) throw new Error('should be {choice, option}')
    const {choice, option} = value
    if (typeof choice !== 'string' || typeof option !== 'string') throw new Error('should be {choice, option}')
    return JSON.stringify({choice, option})
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

/** A chunk's focus can be narrowed to its issues of some open statuses, `{status: 'todo,started'}` (ids or kinds),
 * and to those set for a release. */
export const CHUNK_SIGNAL_FIELDS: Record<string, Field> = {
    ...SIGNAL_FIELDS,
    status: {type: 'string', nullable: true},
    release: {type: 'string', nullable: true},
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
    focus_prompt: {type: 'string', nullable: true},
    chunk_prompt: {type: 'string', nullable: true},
    instructions: {type: 'lines', nullable: true},
    tracker: {type: 'string', nullable: true, pattern: /^https?:\/\/\S*\{id\}\S*$/, hint: 'use the web address of a task with {id} where its id goes, e.g. https://linear.app/you/issue/{id}'},
    handle: {type: 'string', nullable: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/, hint: 'use letters, digits, dots, dashes and underscores, e.g. your GitHub login'},
    /** `{limit, minutes?, idle_minutes?}` lets Orrery start sessions, for any project with a launcher; null stops that. */
    starts: {type: 'json', nullable: true, parse: parseStarts},
}

/** A preset's name and its text, both needed. */
export const PRESET_FIELDS: Record<string, Field> = {
    name: {type: 'string', required: true},
    text: {type: 'string', required: true},
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

export const UPLOAD_FIELDS: Record<string, Field> = {
    /** The image, base64 (a `data:` URL works too). */
    data: {type: 'string', required: true},
    /** The file's name, for the Markdown's alt text. */
    name: {type: 'string', nullable: true},
}

/** How big an image can be, in bytes. */
export const UPLOAD_LIMIT = 10 * 1024 * 1024

/** The images Orrery takes, told by their first bytes rather than what the sender says (no SVG: it can run script). */
const IMAGE_TYPES: [string, (bytes: Buffer) => boolean][] = [
    ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
    ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ['image/gif', b => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1'))],
    ['image/webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
]

/** Whether the owner has commented on the issue since comment `c`. */
const ANSWERED = 'EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id) AS answered'

export class Store {
    constructor(
        readonly db: Db,
        private readonly onChange: (project: string) => void = () => {},
        private readonly onSignal: (signal: Signal) => void = () => {},
        private readonly onNotice: (notice: Notice) => void = () => {},
        private readonly onSettings: (settings: Settings) => void = () => {},
        /** The owner's id until they give their name (what Orrery used before it asked). */
        private readonly unnamed = 'owner',
    ) {}

    /** Whether a session on the project is there to hear a signal now; the server sets it from its sessions. */
    hears: (project: string, session: string) => boolean = () => true

    /** Notes that `session` is working the issue (it wrote to it, or was asked to focus on it): the owner's
     * comments on it go to that session from now on. An issue that isn't there (any more) is let be. */
    async workedBy(project: string, issue: string, session: string) {
        issue = await this.issueId(project, issue)
        await this.run(`INSERT INTO issue_sessions (project, issue, session, at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE project = ? AND id = ?)
            ON CONFLICT (project, issue) DO UPDATE SET session = excluded.session, at = excluded.at`, project, issue, session, stamp(), project, issue)
    }

    /** Refuses `session` starting an issue (`status` a started one, in review too) that another session already
     * has started while that one is there to hear: every session is `claude`, so two that heard the same message would
     * otherwise both take it up. One no session is on any more is free to take over. */
    async claim(project: string, issue: string, status: Input[string], session: string) {
        if (status === undefined) return
        issue = await this.issueId(project, issue)
        const statuses = await this.statuses()
        const started = (id: string) => statuses.find(s => s.id === id)?.kind === 'started'
        if (!started(await this.resolveStatus(status)) || !started((await this.issueRow(project, issue)).status)) return
        const worker = (await this.get<{session: string}>('SELECT session FROM issue_sessions WHERE project = ? AND issue = ?', project, issue))?.session
        if (worker && worker !== session && this.hears(project, worker)) {
            throw conflict(`${issue} is already being worked on by another session (${worker}); pick another issue`)
        }
    }

    /** The issues in progress (a started status) that one of `sessions` worked last, with their latest comment. */
    async workingOn(project: string, sessions: string[]): Promise<(IssueRecord & {last?: Comment})[]> {
        if (!sessions.length) return []
        const worked = new Set((await this.all<{issue: string}>(`SELECT issue FROM issue_sessions WHERE project = ? AND session IN (${sessions.map(() => '?').join(', ')})`,
            project, ...sessions)).map(r => r.issue))
        const issues = (await this.listIssues(project)).filter(r => worked.has(r.id) && r.kind === 'started')
        if (!issues.length) return []
        // Their comments in one query, not one each: the hook asking for this waits on it.
        const last = new Map<string, Comment>()
        for (const row of await this.all<CommentRow>(`SELECT c.*, ${ANSWERED} FROM comments c WHERE project = ? AND issue IN (${issues.map(() => '?').join(', ')}) ORDER BY created_at, id`,
            project, ...issues.map(i => i.id))) last.set(row.issue, commentOf(row))
        return issues.map(issue => ({...issue, last: last.get(issue.id)}))
    }

    /** A session's new id (after a `/clear`) takes over what its old one worked and was sent, so none of it
     * hangs on the server remembering the old id. */
    async renameSession(project: string, from: string, to: string) {
        await this.run('UPDATE issue_sessions SET session = ? WHERE project = ? AND session = ?', to, project, from)
        await this.run('UPDATE signals SET target = ? WHERE project = ? AND target = ?', to, project, from)
    }

    /** The owner's id: what waits on them (a proposal, an agent's ask) is assigned to it. */
    private async ownerId() {
        return (await this.ownerOf()).name
    }

    /** An assignee as stored: `owner` is the owner's id, whatever their name, so an agent needn't know it. */
    private async assigneeOf(value: Input[string]): Promise<string | null | undefined> {
        if (value === undefined) return undefined
        const name = String(value ?? '').trim()
        return name.toLowerCase() === 'owner' ? await this.ownerId() : name || null
    }

    /** The owner: their name as the page shows it, their `Orrery-Actor` id, and whether they've given it. */
    async ownerOf(): Promise<Owner> {
        const row = await this.get<{value: string}>("SELECT value FROM settings WHERE key = 'owner'")
        const display = row ? String(JSON.parse(row.value)) : ''
        return display ? {name: actorId(display), display, named: true} : {name: this.unnamed, display: this.unnamed, named: false}
    }

    /** Names the owner: anyone may the first time (the page asks on first open), then only the owner. What
     * was theirs under the old id (what they made, what's assigned to them, their decisions) moves to the new one. */
    async nameOwner(body: unknown, actor = AGENT): Promise<Owner> {
        const before = await this.ownerOf()
        if (before.named && !actor.owner) throw forbidden("Only the owner renames the owner; send Orrery-Actor: <owner>")
        const display = String(checkInput(body, OWNER_FIELDS).name).trim().slice(0, 60)
        const name = actorId(display)
        if (!name) throw badRequest('The name needs a letter or a digit in it')
        if (name === AGENT.name) throw badRequest(`"${AGENT.name}" is what requests without Orrery-Actor are; pick another name`)
        // Every agent sends this one, as the guide tells it to: as the owner's name it would make them all the owner.
        if (name === 'claude') throw badRequest('"claude" is what agents send as Orrery-Actor; pick another name')
        await this.db.transaction(async () => {
            await this.run("INSERT INTO settings (key, value) VALUES ('owner', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(display))
            if (name === before.name) return
            for (const table of ['projects', 'chunks', 'issues', 'docs', 'comments', 'signals', 'schedules', 'issue_events'])
                await this.run(`UPDATE ${table} SET created_by = ? WHERE owned = 1 AND lower(created_by) = ?`, name, before.name)
            await this.run('UPDATE issues SET assignee = ? WHERE lower(assignee) = ?', name, before.name)
            await this.run('UPDATE issues SET decided_by = ? WHERE lower(decided_by) = ?', name, before.name)
        })
        if (name !== before.name) for (const {id} of await this.all<{id: string}>('SELECT id FROM projects')) this.changed(id)
        // Open pages hear it with the settings, and ask who the owner is now.
        this.onSettings(await this.settings())
        return await this.ownerOf()
    }

    /** Agents' comments across projects. The `bell`: the latest 30 not cleared, those still waiting on the
     * owner (a decision or feedback they haven't answered) first. The notifications page's lists, newest
     * first: `waiting` (every one), and `inbox` (the rest) and `cleared` a page at a time, `limit` of them
     * (50, at most 200) older than the notice `before`. */
    async notices({list = 'bell', before, limit}: {list?: NoticeList, before?: number, limit?: number} = {}): Promise<Notice[]> {
        const which = {
            bell: 'cleared = 0',
            waiting: 'cleared = 0 AND asks IS NOT NULL AND NOT answered',
            inbox: 'cleared = 0 AND NOT (asks IS NOT NULL AND NOT answered)',
            cleared: 'cleared = 1',
        }[list]
        if (!NOTICE_LISTS.includes(list)) throw badRequest(`Unknown list "${list}"; use ${NOTICE_LISTS.join(', ')}`)
        const paged = list === 'inbox' || list === 'cleared'
        const after = paged && before !== undefined ? 'AND (created_at, id) < (SELECT created_at, id FROM comments WHERE id = ?)' : ''
        const count = list === 'bell' ? 30 : paged ? Math.min(Math.max(1, limit ?? 50), 200) : undefined
        return (await this.all<CommentRow & {title: string, cleared: number}>(`
            SELECT * FROM (
                SELECT c.*, i.title, ${ANSWERED} FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue
                WHERE c.owned = 0) AS listed
            WHERE ${which} ${after}
            ORDER BY ${list === 'bell' ? '(asks IS NOT NULL AND NOT answered) DESC, ' : ''}created_at DESC, id DESC ${count ? 'LIMIT ?' : ''}`,
        ...after ? [before!] : [], ...count ? [count] : []))
            .map(row => ({...commentOf(row), project: row.project, title: row.title, ...row.cleared ? {cleared: true} : {}}))
    }

    /** Takes notices out of the bell (the comments stay on their issues): those in `ids`, or all made at
     * or before `before`. Says how many. */
    async clearNotices(body: unknown): Promise<number> {
        const {ids, before} = (body ?? {}) as {ids?: unknown, before?: unknown}
        if (Array.isArray(ids) && ids.every(id => Number.isInteger(id)) && ids.length) {
            return Number((await this.run(`UPDATE comments SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND id IN (${ids.map(() => '?').join(', ')})`, ...ids as number[])).changes)
        }
        if (typeof before === 'string' && before) {
            // Not the ones still waiting on the owner: those go when they're answered, or one by one.
            return Number((await this.run(`UPDATE comments AS c SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND created_at <= ?
                AND (asks IS NULL OR EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id))`, before)).changes)
        }
        throw badRequest('Send "ids" (comment ids) or "before" (a time) to clear')
    }

    // Projects

    async listProjects(): Promise<ProjectSummary[]> {
        return Promise.all((await this.all<ProjectRow>('SELECT * FROM projects ORDER BY lower(name), name')).map(async row => {
            const {board, ...project} = await this.projectOf(row)
            return {...project, counts: board.counts, kinds: board.kinds, chunks: board.chunks.filter(c => c.id).length}
        }))
    }

    async listBoards(): Promise<Project[]> {
        return Promise.all((await this.all<ProjectRow>('SELECT * FROM projects ORDER BY lower(name), name')).map(row => this.projectOf(row)))
    }

    async project(id: string): Promise<Project> {
        return await this.projectOf(await this.projectRow(id))
    }

    /** The project's id, or a 404 when there's none, without building its board. */
    async projectId(id: string): Promise<string> {
        return (await this.projectRow(id)).id
    }

    async createProject(body: unknown, actor = AGENT): Promise<Project> {
        const input = checkInput(body, PROJECT_FIELDS)
        this.promptsAreTheOwners(input, actor)
        const name = String(input.name).trim()
        const id = input.id ? String(input.id) : slugify(name)
        if (!SLUG.test(id)) throw badRequest(`"${name}" doesn't make an id; give one in "id"`)
        if (await this.get('SELECT 1 FROM projects WHERE id = ?', id)) throw conflict(`There is already a project "${id}"`)
        const key = input.key ? String(input.key) : keyFor(name)
        const {mode, from} = releaseModeOf(input, 'none', null)
        if (from) await this.checkReleasesFrom(id, from)
        const now = stamp()
        await this.run('INSERT INTO projects (id, name, key, description, icon, icon_color, repo, release_mode, releases_from, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            id, name, key, nullable(input.description), nullable(input.icon), nullable(input.icon_color), nullable(input.repo), mode, from, actor.name, Number(actor.owner), now, now)
        await this.update('projects', 'id = ?', [id], this.promptColumns(input))
        this.changed(id)
        return await this.project(id)
    }

    async updateProject(id: string, body: unknown, actor = AGENT): Promise<Project> {
        const row = await this.projectRow(id)
        const input = checkInput(body, PROJECT_FIELDS, true)
        this.promptsAreTheOwners(input, actor)
        if (input.id !== undefined && input.id !== id) throw badRequest("A project's id can't change")
        const {mode, from} = releaseModeOf(input, row.release_mode, row.releases_from)
        const before = row.releases_from
        if (mode !== row.release_mode || from !== before) await this.checkReleaseMode(row, mode, from)
        await this.db.transaction(async () => {
            await this.update('projects', 'id = ?', [id], {
                name: input.name === undefined ? undefined : String(input.name).trim(),
                key: input.key,
                description: input.description,
                icon: input.icon,
                icon_color: input.icon_color,
                repo: input.repo,
                release_mode: mode,
                releases_from: from,
                ...this.promptColumns(input),
            })
            // Its issues keep only the releases the new source has: none without releases, or back on its own (it has none yet).
            if (mode !== row.release_mode || from !== before) {
                const source = mode === 'shared' ? from : mode === 'own' ? id : null
                if (source) await this.run('UPDATE issues SET ships_in = NULL WHERE project = ? AND ships_in IS NOT NULL AND ships_in NOT IN (SELECT version FROM releases WHERE project = ?)', id, source)
                else await this.run('UPDATE issues SET ships_in = NULL WHERE project = ?', id)
            }
        })
        this.changed(id)
        // The old source counted its issues, and the new one does now.
        if (before && before !== from) this.changed(before)
        return await this.project(id)
    }

    /** Whether the project can leave its own releases (for none, or another's): nothing of its own to lose or
     * merge, and nobody drawing on them; and when it takes another's, that they can be taken. */
    private async checkReleaseMode(row: ProjectRow, mode: ReleaseMode, from: string | null) {
        if (row.release_mode === 'own' && mode !== 'own') {
            const drawing = await this.drawingOn(row.id)
            if (drawing.length) throw conflict(`${drawing.join(', ')} ${drawing.length === 1 ? 'takes its' : 'take their'} releases from ${row.id}, so it keeps its own`)
            const own = await this.all<{version: string}>('SELECT version FROM releases WHERE project = ? ORDER BY version', row.id)
            if (own.length) throw conflict(`${row.id} has releases of its own (${own.map(r => r.version).join(', ')}); delete them first, ${mode === 'shared' ? `nothing merges into ${from}'s` : 'nothing goes quietly'}`)
        }
        if (from) await this.checkReleasesFrom(row.id, from)
    }

    /** Whether `id` can take its releases from `from`: another project with releases of its own, one level only. */
    private async checkReleasesFrom(id: string, from: string) {
        if (from === id) throw badRequest("A project can't take its releases from itself; send release_mode \"own\" to give it its own")
        const source = await this.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', from)
        if (!source) throw badRequest(`No project "${from}" to take releases from`)
        if (source.release_mode === 'shared') throw badRequest(`${from} takes its releases from ${source.releases_from}; take them from ${source.releases_from} too`)
        if (source.release_mode === 'none') throw badRequest(`${from} has no releases; give it its own first (release_mode "own")`)
    }

    /** The project its releases are: its `releases_from`, its own, or none when it has no releases. */
    private async releaseSource(project: string): Promise<string | null> {
        const row = await this.projectRow(project)
        return row.release_mode === 'shared' ? row.releases_from : row.release_mode === 'own' ? project : null
    }

    /** The projects taking their releases from `project`, by id. */
    private async drawingOn(project: string): Promise<string[]> {
        return (await this.all<{id: string}>('SELECT id FROM projects WHERE releases_from = ? ORDER BY id', project)).map(r => r.id)
    }

    /** Tells the page the project changed (also after a write made outside the store, a schedule marking its
     * issue), and the projects sharing its releases: a source counts the issues of those drawing on it, and they
     * show its releases. */
    changed(project: string) {
        if (this.held) return void this.held.add(project)
        this.onChange(project)
        this.all<{id: string}>('SELECT id FROM projects WHERE releases_from = ? OR id = (SELECT releases_from FROM projects WHERE id = ?)', project, project)
            .then(rows => rows.forEach(r => this.onChange(r.id)), () => {})
    }

    private promptsAreTheOwners(input: Input, actor: Actor) {
        const sent = PROMPT_FIELDS.filter(key => input[key] !== undefined)
        if (sent.length && !actor.owner) throw forbidden(`Only the owner changes what sessions are told (${sent.join(', ')}); send Orrery-Actor: <owner>`)
    }

    /** The prompt fields as columns: an empty template is none (the Orrery's). */
    private promptColumns(input: Input): Input {
        const template = (value: Input[string]) => value === undefined ? undefined : String(value ?? '').trim() || null
        const list = (value: Input[string]) => value === undefined ? undefined : JSON.stringify(value ?? [])
        return {
            focus_prompt: template(input.focus_prompt), chunk_prompt: template(input.chunk_prompt), instructions: list(input.instructions), muted: list(input.muted),
        }
    }

    /** Whether Orrery may start sessions for the project, and within what: the Orrery's, as the owner lets it start
     * them for every project at once; none while they haven't. */
    async starts(project: string): Promise<Starts | undefined> {
        await this.projectRow(project)
        return await this.orreryStarts()
    }

    private async orreryStarts(): Promise<Starts | undefined> {
        const row = await this.get<{value: string}>('SELECT value FROM settings WHERE key = ?', 'starts')
        return (row ? JSON.parse(row.value) as Starts | null : null) ?? undefined
    }

    /** The templates the project's sessions hear: its own, else the Orrery's, else the defaults. */
    async prompts(project: string): Promise<{focus: string, chunk: string}> {
        const row = await this.projectRow(project)
        const settings = await this.settings()
        return {
            focus: row.focus_prompt ?? settings.focus_prompt ?? DEFAULT_FOCUS_PROMPT,
            chunk: row.chunk_prompt ?? settings.chunk_prompt ?? DEFAULT_CHUNK_PROMPT,
        }
    }

    /** The texts of the standing instructions for a focus: those named by id, or else the ones ticked by default. */
    private async instructionsFor(project: string, ids: Input[string]): Promise<string[]> {
        const row = await this.projectRow(project)
        const global = (await this.settings()).instructions
        const own = JSON.parse(row.instructions) as Instruction[]
        if (ids === undefined || ids === null) return defaultInstructions(global, own, JSON.parse(row.muted) as string[]).map(i => i.text)
        const all = [...global, ...own]
        const unknown = (ids as string[]).filter(id => !all.some(i => i.id === id))
        if (unknown.length) throw badRequest(`No standing instruction ${unknown.join(', ')}; the Orrery's and ${project}'s are ${all.map(i => i.id).join(', ') || 'none'}`)
        return all.filter(i => (ids as string[]).includes(i.id)).map(i => i.text)
    }

    async deleteProject(id: string, actor = AGENT) {
        this.refuse(actor, `Deleting ${id}`, await this.ownedIn(id))
        const drawing = await this.drawingOn(id)
        if (drawing.length) throw conflict(`${drawing.join(', ')} ${drawing.length === 1 ? 'takes its' : 'take their'} releases from ${id}; give ${drawing.length === 1 ? 'it its' : 'them their'} own first (releases_from: null)`)
        await this.db.transaction(async () => {
            // Comments and issues first: the foreign keys would refuse the project going before them.
            await this.run('DELETE FROM comments WHERE project = ?', id)
            await this.run('UPDATE issues SET parent = NULL, chunk = NULL WHERE project = ?', id)
            await this.run('DELETE FROM issues WHERE project = ?', id)
            await this.run('DELETE FROM chunks WHERE project = ?', id)
            await this.run('DELETE FROM docs WHERE project = ?', id)
            await this.run('DELETE FROM releases WHERE project = ?', id)
            await this.run('DELETE FROM issue_aliases WHERE project = ?', id)
            await this.run('DELETE FROM chunk_aliases WHERE project = ?', id)
            await this.run('DELETE FROM signals WHERE project = ?', id)
            await this.run('DELETE FROM schedules WHERE project = ?', id)
            await this.run('DELETE FROM presets WHERE project = ?', id)
            await this.run('DELETE FROM projects WHERE id = ?', id)
        })
        this.changed(id)
    }

    /** This Orrery's own settings. */
    async settings(): Promise<Settings> {
        let rows = await this.all<{key: string, value: string}>('SELECT key, value FROM settings')
        // Its id is made the first time it's asked for, and kept.
        if (!rows.some(r => r.key === 'id')) {
            await this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', 'id', JSON.stringify(`orr_${randomBytes(3).toString('hex')}`))
            rows = await this.all<{key: string, value: string}>('SELECT key, value FROM settings')
        }
        const value = (key: string) => {
            const row = rows.find(r => r.key === key)
            return row ? JSON.parse(row.value) as unknown : undefined
        }
        return {
            id: value('id') as string,
            tint: (value('tint') as string | undefined) ?? null,
            statuses: await this.statuses(),
            focus_prompt: (value('focus_prompt') as string | undefined) || null,
            chunk_prompt: (value('chunk_prompt') as string | undefined) || null,
            instructions: (value('instructions') as Instruction[] | undefined) ?? [],
            handle: (value('handle') as string | undefined) || null,
            tracker: (value('tracker') as string | undefined) || null,
            starts: (value('starts') as Starts | null | undefined) ?? null,
        }
    }

    /** The handle in issues' references: the owner's, or else their id. */
    private async handle(): Promise<string> {
        return (await this.settings()).handle ?? (await this.ownerOf()).name
    }

    // Presets

    /** The Orrery's presets, by name; with a project, those a session on it can have: the Orrery's, then its own. */
    async presets(project?: string): Promise<Preset[]> {
        if (project) await this.projectRow(project)
        return await this.all<PresetRow>('SELECT id, project, name, text, created_at, updated_at FROM presets WHERE project IS NULL OR project = ? ORDER BY project IS NOT NULL, lower(name), id', project ?? null)
    }

    async preset(id: number): Promise<Preset> {
        const row = Number.isInteger(id) ? await this.get<PresetRow>('SELECT id, project, name, text, created_at, updated_at FROM presets WHERE id = ?', id) : undefined
        if (!row) throw notFound(`No preset ${id}`)
        return row
    }

    /** A new preset, the owner's to make: `{name, text}`, the Orrery's, or with `project` that project's own. */
    async createPreset(project: string | null, body: unknown, actor = AGENT): Promise<Preset> {
        this.ownerOnly(actor, 'presets')
        if (project) await this.projectRow(project)
        const {name, text} = presetInput(checkInput(body, PRESET_FIELDS))
        const now = stamp()
        const row = await this.get<{id: number}>('INSERT INTO presets (project, name, text, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
            project, name!, text!, actor.name, Number(actor.owner), now, now)
        return await this.preset(Number(row!.id))
    }

    /** Renames a preset or changes its text; whose it is stays. */
    async updatePreset(id: number, body: unknown, actor = AGENT): Promise<Preset> {
        this.ownerOnly(actor, 'presets')
        await this.preset(id)
        const {name, text} = presetInput(checkInput(body, PRESET_FIELDS, true))
        await this.run('UPDATE presets SET name = coalesce(?, name), text = coalesce(?, text), updated_at = ? WHERE id = ?', name ?? null, text ?? null, stamp(), id)
        return await this.preset(id)
    }

    async deletePreset(id: number, actor = AGENT) {
        this.ownerOnly(actor, 'presets')
        await this.preset(id)
        await this.run('DELETE FROM presets WHERE id = ?', id)
    }

    /** The presets picked for a session on the project, in the order picked: each the Orrery's or the project's own. */
    async presetsFor(project: string, ids: number[]): Promise<Preset[]> {
        const usable = await this.presets(project)
        const unknown = ids.filter(id => !usable.some(p => p.id === id))
        if (unknown.length) throw badRequest(`No preset ${unknown.join(', ')} for ${project}; its sessions can have ${usable.map(p => `${p.id} (${p.name})`).join(', ') || 'none yet'}`)
        return [...new Set(ids)].map(id => usable.find(p => p.id === id)!)
    }

    // Statuses

    /** The issue statuses, in board order: by kind, then as arranged. */
    async statuses(): Promise<IssueStatus[]> {
        const rows = await this.all<IssueStatus>('SELECT id, name, kind, color, position FROM statuses ORDER BY position, id')
        return KINDS.flatMap(kind => rows.filter(r => r.kind === kind))
    }

    /** A new status, the owner's to add: `{name, kind, color?, id?, position?}`. */
    async createStatus(body: unknown, actor = AGENT): Promise<IssueStatus> {
        this.ownerOnly(actor, 'statuses')
        const input = checkInput(body, {...STATUS_FIELDS, color: {...STATUS_FIELDS.color!, required: false}})
        const name = String(input.name).trim()
        const id = input.id ? String(input.id) : slugify(name)
        if (!SLUG.test(id)) throw badRequest(`"${name}" doesn't make an id; give one in "id"`)
        if (id === 'proposed') throw badRequest('"proposed" is where proposals sit; give the status another id')
        if (await this.get('SELECT 1 FROM statuses WHERE id = ?', id)) throw conflict(`There is already a status "${id}"`)
        const position = input.position ?? ((await this.get<{n: number | null}>('SELECT max(position) AS n FROM statuses'))?.n ?? 0) + 1
        await this.run('INSERT INTO statuses (id, name, kind, color, position) VALUES (?, ?, ?, ?, ?)', id, name, String(input.kind), String(input.color ?? 'slate'), Number(position))
        await this.statusesChanged()
        return await this.status(id)
    }

    /** Renames, recolours or moves a status, or gives it another kind (not the last of its kind). */
    async updateStatus(id: string, body: unknown, actor = AGENT): Promise<IssueStatus> {
        this.ownerOnly(actor, 'statuses')
        const before = await this.status(id)
        const input = checkInput(body, STATUS_FIELDS, true)
        if (input.id !== undefined && input.id !== id) throw badRequest("A status's id can't change; rename it with \"name\"")
        if (input.kind !== undefined && input.kind !== before.kind) await this.keepOneOf(before)
        await this.run('UPDATE statuses SET name = coalesce(?, name), kind = coalesce(?, kind), color = coalesce(?, color), position = coalesce(?, position) WHERE id = ?',
            input.name === undefined ? null : String(input.name).trim(), nullable(input.kind), nullable(input.color), input.position === undefined ? null : Number(input.position), id)
        await this.statusesChanged()
        return await this.status(id)
    }

    /** Removes a status; its issues and schedules move to `into` (another status), which it needs when it has any. */
    async deleteStatus(id: string, into: string | undefined, actor = AGENT) {
        this.ownerOnly(actor, 'statuses')
        const status = await this.status(id)
        await this.keepOneOf(status)
        const used = (await this.get<{n: number}>('SELECT (SELECT count(*) FROM issues WHERE status = ?) + (SELECT count(*) FROM schedules WHERE place = ?) AS n', id, id))!.n
        if (into !== undefined) await this.status(into)
        if (into === id) throw badRequest('Move its issues to another status')
        if (used && !into) throw conflict(`${used} issues or schedules are in ${status.name}; say which status they move to with ?into=`)
        await this.db.transaction(async () => {
            if (into) {
                await this.run('UPDATE issues SET status = ? WHERE status = ?', into, id)
                await this.run('UPDATE schedules SET place = ? WHERE place = ?', into, id)
                await this.run('UPDATE signals SET status = ? WHERE status = ?', into, id)
            }
            await this.run('DELETE FROM statuses WHERE id = ?', id)
        })
        await this.statusesChanged()
    }

    async status(id: string): Promise<IssueStatus> {
        const found = (await this.statuses()).find(s => s.id === id)
        if (!found) throw notFound(`No status "${id}"`)
        return found
    }

    /** The status an issue gets from what was sent: a status's id, a kind (its first status), or the words
     * from before statuses (`doing`; `todo` with a `plan`). */
    async resolveStatus(status: Input[string], plan?: Input[string]): Promise<string> {
        const statuses = await this.statuses()
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
    /** The status ids a status's id or kind stands for; several, comma-separated, stand for all of theirs. */
    private async statusIds(status: string): Promise<string[]> {
        const statuses = await this.statuses()
        const of = (one: string) => {
            if (statuses.some(s => s.id === one)) return [one]
            const kind = (KINDS.includes(one as Kind) ? one : LEGACY_KINDS[one]) as Kind | undefined
            return kind ? statuses.filter(s => s.kind === kind).map(s => s.id) : []
        }
        return [...new Set(status.split(',').map(s => s.trim()).filter(Boolean).flatMap(of))]
    }

    private async keepOneOf(status: IssueStatus) {
        if ((await this.statuses()).filter(s => s.kind === status.kind).length === 1) throw conflict(`${status.name} is the only ${status.kind} status; add another before it goes`)
    }

    private ownerOnly(actor: Actor, what: string) {
        if (!actor.owner) throw forbidden(`Only the owner changes the ${what}; send Orrery-Actor: <owner>`)
    }

    /** Every board is drawn again with them, and the page gets the new list with the settings. */
    private async statusesChanged() {
        this.onSettings(await this.settings())
        for (const {id} of await this.all<{id: string}>('SELECT id FROM projects')) this.changed(id)
    }

    /** The owner's to change: they're how the Orrery looks to them. */
    async updateSettings(body: unknown, actor = AGENT): Promise<Settings> {
        if (!actor.owner) throw forbidden("Only the owner changes the Orrery's settings; send Orrery-Actor: <owner>")
        const input = checkInput(body, SETTINGS_FIELDS, true)
        await this.db.transaction(async () => {
            for (const [key, sent] of Object.entries(input)) {
                if (sent === undefined) continue
                // An empty template is none: the default.
                const value = (key === 'focus_prompt' || key === 'chunk_prompt') && typeof sent === 'string' ? sent.trim() || null
                    : key === 'handle' && typeof sent === 'string' ? sent.toLowerCase()
                    // Checked and given back as JSON text: kept as the value it stands for.
                    : key === 'starts' && typeof sent === 'string' ? JSON.parse(sent) as unknown : sent
                await this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
            }
        })
        const settings = await this.settings()
        this.onSettings(settings)
        // Every project says whether Orrery starts its sessions.
        if (input.starts !== undefined) for (const {id} of await this.all<{id: string}>('SELECT id FROM projects')) this.changed(id)
        return settings
    }

    // Chunks

    async listChunks(project: string): Promise<ChunkRecord[]> {
        const {board} = await this.project(project)
        return (await this.all<ChunkRow>('SELECT * FROM chunks WHERE project = ? ORDER BY position, created_at', project))
            .map(row => this.chunkRecord(row, board.chunks.find(c => c.id === row.id)!))
    }

    async chunk(project: string, id: string): Promise<ChunkRecord & {tasks: Issue[]}> {
        id = await this.chunkId(project, id)
        const row = await this.chunkRow(project, id)
        const view = (await this.project(project)).board.chunks.find(c => c.id === id)!
        return {...this.chunkRecord(row, view), tasks: view.tasks}
    }

    async createChunk(project: string, body: unknown, actor = AGENT): Promise<ChunkRecord & {tasks: Issue[]}> {
        await this.projectRow(project)
        const input = checkInput(body, CHUNK_FIELDS)
        const title = String(input.title).trim()
        const now = stamp()
        const id = await this.db.transaction(async () => {
            const id = await this.nextId(project, 'chunk')
            await this.run('INSERT INTO chunks (project, id, title, summary, priority, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, nullable(input.summary), nullable(input.priority), Number(input.position ?? await this.nextPosition('chunks', project)), actor.name, Number(actor.owner), now, now)
            await this.touchProject(project)
            return id
        })
        this.changed(project)
        return await this.chunk(project, id)
    }

    async updateChunk(project: string, id: string, body: unknown): Promise<ChunkRecord & {tasks: Issue[]}> {
        id = await this.chunkId(project, id)
        await this.chunkRow(project, id)
        const input = checkInput(body, CHUNK_FIELDS, true)
        await this.db.transaction(async () => {
            await this.update('chunks', 'project = ? AND id = ?', [project, id], {
                title: input.title === undefined ? undefined : String(input.title).trim(),
                summary: input.summary,
                priority: input.priority,
                position: input.position,
            })
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.chunk(project, id)
    }

    /** Its issues stay, in no chunk. */
    async deleteChunk(project: string, id: string, actor = AGENT) {
        id = await this.chunkId(project, id)
        const row = await this.chunkRow(project, id)
        this.refuse(actor, `Deleting chunk "${id}"`, row.owned ? [`chunk "${id}"`] : [])
        await this.db.transaction(async () => {
            await this.run('UPDATE issues SET chunk = NULL WHERE project = ? AND chunk = ?', project, id)
            await this.run('DELETE FROM chunk_aliases WHERE project = ? AND chunk = ?', project, id)
            await this.run('DELETE FROM signals WHERE project = ? AND chunk = ?', project, id)
            // Schedules that made issues in it make them in no chunk from now on.
            await this.run('UPDATE schedules SET chunk = NULL WHERE project = ? AND chunk = ?', project, id)
            await this.run('DELETE FROM chunks WHERE project = ? AND id = ?', project, id)
            await this.touchProject(project)
        })
        this.changed(project)
    }

    // Issues

    async listIssues(project: string, filter: IssueFilter = {}): Promise<IssueRecord[]> {
        const records = this.issueRecords(await this.project(project))
        if (filter.chunk && filter.chunk !== 'none') filter = {...filter, chunk: await this.chunkId(project, filter.chunk)}
        if (filter.parent && filter.parent !== 'none') filter = {...filter, parent: await this.issueId(project, filter.parent)}
        if (filter.release && filter.release !== 'none') await this.releaseRow(project, filter.release)
        const q = filter.q?.toLowerCase()
        const statuses = filter.status ? await this.statusIds(filter.status) : []
        const columns = filter.column === 'proposed' ? ['proposed'] : filter.column ? await this.statusIds(filter.column) : []
        const assignee = filter.assignee && filter.assignee !== 'none' ? await this.assigneeOf(filter.assignee) : undefined
        const handle = await this.handle()
        return records.map(r => ({...r, ref: issueRef(handle, r.id)})).filter(r =>
            (!filter.status || statuses.includes(r.status))
            && (!filter.priority || (filter.priority === 'none' ? !r.priority : r.priority === filter.priority))
            && (!filter.column || columns.includes(r.column))
            && (!filter.assignee || (filter.assignee === 'none' ? !r.assignee : r.assignee === assignee))
            && (!filter.label || r.labels.includes(filter.label))
            && (!filter.external || r.external.includes(filter.external))
            && (!filter.chunk || (filter.chunk === 'none' ? !r.chunk : r.chunk === filter.chunk))
            && (!filter.release || (filter.release === 'none' ? !r.release : r.release === filter.release))
            && (!filter.parent || (filter.parent === 'none' ? !r.parent : r.parent === filter.parent))
            && (!filter.proposal || (filter.proposal === 'none' ? r.column !== 'proposed' : r.proposal === filter.proposal))
            && (!q || r.id.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)))
    }

    async issue(project: string, id: string): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        const found = this.findIssue(await this.project(project), id)
        if (!found) throw notFound(`No issue ${id} in ${project}`)
        return {...found.issue, project, parent: found.parent, chunk: found.chunk || null, ref: issueRef(await this.handle(), id)}
    }

    /** `urgent: false` leaves a P0 issue's push to the caller, which asks the sessions itself. */
    async createIssue(project: string, body: unknown, actor = AGENT, {urgent = true} = {}): Promise<IssueDetail> {
        await this.projectRow(project)
        const input = checkInput(body, ISSUE_FIELDS)
        if (input.project !== undefined && input.project !== project) throw badRequest(`Create the issue in its project: POST /api/projects/${input.project}/issues`)
        const parent = input.parent ? await this.issueId(project, String(input.parent)) : null
        const chunk = input.chunk ? await this.chunkId(project, String(input.chunk)) : null
        if (parent) {
            await this.issueRow(project, parent)
            if (chunk) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or "parent"`)
        }
        if (chunk) await this.chunkRow(project, chunk)
        const release = input.release ? (await this.releaseRow(project, String(input.release))).version : null

        const id = await this.db.transaction(async () => {
            const id = await this.nextId(project, 'issue')
            const now = stamp()
            await this.run(`INSERT INTO issues (project, id, title, status, priority, assignee, labels, external, notes, proposal, choices, parent, chunk, ships_in, position,
                                          created_by, owned, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, id, String(input.title).trim(), await this.resolveStatus(input.status, input.plan), nullable(input.priority),
                // A proposal waits on the owner, so it's theirs, whoever the request names.
                input.proposal === 'pending' ? (await this.ownerId()) : nullable(await this.assigneeOf(input.assignee)),
                JSON.stringify(input.labels ?? []), JSON.stringify(tasksOf(input.external)), nullable(input.notes), nullable(input.proposal), String(input.choices ?? '[]'),
                parent, chunk, release, Number(input.position ?? await this.nextPosition('issues', project)), actor.name, Number(actor.owner), now, now)
            await this.record(project, id, actor, [['created', null, null]])
            await this.touchProject(project)
            return id
        })
        this.changed(project)
        if (urgent) await this.urgent(project, null, await this.issueRow(project, id), actor)
        return await this.issue(project, id)
    }

    /** `parent: null` lifts a sub-issue to the top, into the chunk it was in unless `chunk` says otherwise.
     * `project` moves it (with its sub-issues and comments) to the top of another project. `proposal:
     * null` commits a proposal, as the owner (approving one commits it). */
    async updateIssue(project: string, id: string, body: unknown, actor = AGENT): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        await this.issueRow(project, id)
        const input = checkInput(body, ISSUE_FIELDS, true)
        if (input.project !== undefined && input.project !== project) {
            const {project: to, parent, chunk, ...rest} = input
            const moved = await this.moveIssue(project, id, String(to), parent ?? null, chunk ?? null, actor)
            return await this.updateIssue(String(to), moved, rest, actor)
        }
        const row = await this.issueRow(project, id)
        if (input.proposal === null && row.proposal && !actor.owner) {
            throw forbidden(`Committing ${id} is the owner's call until they approve it: it's ${row.proposal === 'pending' ? 'waiting on them' : row.proposal === 'changes' ? 'waiting on changes' : 'rejected'}`)
        }

        const parent = input.parent === undefined ? row.parent : input.parent === null ? null : await this.issueId(project, String(input.parent))
        let chunk = input.chunk === undefined ? undefined : input.chunk === null ? null : await this.chunkId(project, String(input.chunk))
        if (parent) {
            if (chunk) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or set "parent" to null`)
            await this.issueRow(project, parent)
            for (let up: string | null = parent; up; up = (await this.issueRow(project, up)).parent) {
                if (up === id) throw badRequest(`${parent} is ${up === parent ? 'this issue' : 'under this issue'}, so it can't be its parent`)
            }
            chunk = null
        } else if (chunk === undefined && row.parent) {
            chunk = (await this.rootOf(project, row)).chunk
        }
        if (chunk) await this.chunkRow(project, chunk)
        const release = input.release === undefined ? undefined : input.release === null ? null : (await this.releaseRow(project, String(input.release))).version

        const title = input.title === undefined ? undefined : String(input.title).trim()
        const status = input.status === undefined && input.plan === undefined ? undefined : await this.resolveStatus(input.status, input.plan)
        const assignee = input.proposal === 'pending' ? (await this.ownerId()) : await this.assigneeOf(input.assignee)
        const labels = input.labels === undefined ? undefined : JSON.stringify(input.labels ?? [])
        const external = input.external === undefined ? undefined : JSON.stringify(tasksOf(input.external))
        const moved = input.parent !== undefined && parent !== row.parent
        await this.db.transaction(async () => {
            await this.record(project, id, actor, [
                ['title', row.title, title],
                ['status', row.status, status],
                ['priority', row.priority, input.priority],
                ['assignee', row.assignee, assignee],
                ['labels', row.labels, labels],
                ['external', row.external, external],
                ['notes', row.notes, input.notes],
                ['proposal', row.proposal, input.proposal],
                // A sub-issue is in its parent's chunk, so a new parent says it all.
                moved ? ['parent', row.parent, parent] : ['chunk', row.chunk, chunk],
                ['release', row.ships_in, release],
            ])
            await this.update('issues', 'project = ? AND id = ?', [project, id], {
                title,
                status,
                priority: input.priority,
                assignee,
                labels,
                external,
                notes: input.notes,
                proposal: input.proposal,
                choices: input.choices === undefined ? undefined : String(input.choices ?? '[]'),
                // Put up again, it waits on a new decision.
                ...input.proposal === 'pending' ? {decided_by: null, decided_at: null, decision_note: null, picks: null, explore: null} : {},
                parent: input.parent === undefined ? undefined : parent,
                chunk,
                ships_in: release,
                position: input.position,
            })
            await this.touchProject(project)
        })
        this.changed(project)
        await this.urgent(project, row, await this.issueRow(project, id), actor)
        return await this.issue(project, id)
    }

    /** An issue the owner's write just made urgent open work (P0, and committed and not closed, which it wasn't
     * before) goes to the sessions as a focus, without their asking: to the session working it while it can hear,
     * else to every session on the project. The write is saved by now, so a push that fails is only logged. */
    private async urgent(project: string, before: IssueRow | null, after: IssueRow, actor: Actor) {
        try {
            const urgentWork = async (row: IssueRow) => row.priority === 'P0' && !row.proposal
                && !CLOSED.includes((await this.statuses()).find(s => s.id === row.status)?.kind as Kind)
            if (!actor.owner || !await urgentWork(after) || (before && await urgentWork(before))) return
            await this.sendFocus(project, after.id, {note: 'It was just made urgent (P0).', session: await this.listeningWorker(project, after.id)}, actor)
        } catch (error) {
            console.error(`[orrery] pushing urgent ${after.id} in ${project}:`, error)
        }
    }

    /** The session that last worked the issue, while it's there to hear; null (every session) otherwise. */
    private async listeningWorker(project: string, issue: string): Promise<string | null> {
        const worker = (await this.get<{session: string}>('SELECT session FROM issue_sessions WHERE project = ? AND issue = ?', project, issue))?.session
        return worker && this.hears(project, worker) ? worker : null
    }

    /** Deletes its sub-issues and comments too. */
    // Many at once

    /** Projects changed while a batch runs, said once it ends rather than once per issue. */
    private held: Set<string> | null = null

    /** Runs `work` for each issue on its own, so one refusal doesn't stop the rest, and says each one's outcome. */
    private async each(ids: unknown, work: (id: string) => Promise<unknown>): Promise<BulkResult[]> {
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw badRequest('Send "ids": the issues, as a list of their ids')
        const held = this.held ??= new Set()
        try {
            const results: BulkResult[] = []
            for (const id of new Set(ids as string[])) {
                try {
                    await work(id)
                    results.push({id, ok: true})
                } catch (error) {
                    results.push({id, ok: false, error: (error as Error).message})
                }
            }
            return results
        } finally {
            if (this.held === held) {
                this.held = null
                held.forEach(project => this.changed(project))
            }
        }
    }

    /** One change to many issues: `{ids, set: {status?, priority?, assignee?, chunk?, release?}, labels?: {add?, remove?}}`. */
    async updateIssues(project: string, body: unknown, actor = AGENT): Promise<BulkResult[]> {
        await this.projectRow(project)
        const {ids, set = {}, labels} = (body ?? {}) as {ids?: unknown, set?: Record<string, unknown>, labels?: {add?: unknown, remove?: unknown}}
        const fields = Object.keys(set ?? {}).filter(key => !BULK_FIELDS.includes(key))
        if (fields.length) throw badRequest(`Many issues at once take ${BULK_FIELDS.join(', ')} in "set", and labels as {add, remove}; not ${fields.join(', ')}`)
        const list = (value: unknown, key: string) => {
            if (value === undefined) return []
            if (!Array.isArray(value) || value.some(l => typeof l !== 'string')) throw badRequest(`"labels.${key}" should be a list of labels`)
            return value as string[]
        }
        const [add, remove] = [list(labels?.add, 'add'), list(labels?.remove, 'remove')]
        return await this.each(ids, async id => {
            const patch: Record<string, unknown> = {...set}
            if (add.length || remove.length) {
                const now = JSON.parse((await this.issueRow(project, await this.issueId(project, id))).labels) as string[]
                patch.labels = [...new Set([...now.filter(l => !remove.includes(l)), ...add])]
            }
            await this.updateIssue(project, id, patch, actor)
        })
    }

    /** The owner's one decision on many proposals: `{ids, decision, note?}`. Approving takes each one's recommended
     * picks; one with a choice that has none is skipped, so nothing is approved on a guess. */
    async decideIssues(project: string, body: unknown, actor = AGENT): Promise<BulkResult[]> {
        await this.projectRow(project)
        const {ids, ...decision} = (body ?? {}) as {ids?: unknown}
        if ('picks' in decision || 'explore' in decision) throw badRequest('Many proposals at once take a decision and a note; picks and explore go one at a time')
        return await this.each(ids, async id => {
            const row = await this.issueRow(project, await this.issueId(project, id))
            const choices = JSON.parse(row.choices) as Choice[]
            const unsure = choices.filter(c => !c.from && !c.recommended?.length)
            if ((decision as {decision?: string}).decision === 'approved' && unsure.length) {
                throw badRequest(`Needs your picks: nothing is recommended for ${unsure.map(c => `"${c.question}"`).join(', ')}`)
            }
            await this.decide(project, id, decision, actor)
        })
    }

    /** Many issues deleted, each with its sub-issues; one under another in the list goes with it. */
    async deleteIssues(project: string, body: unknown, actor = AGENT): Promise<BulkResult[]> {
        await this.projectRow(project)
        const {ids} = (body ?? {}) as {ids?: unknown}
        const gone = new Set<string>()
        return await this.each(ids, async id => {
            id = await this.issueId(project, id)
            if (gone.has(id)) return
            const subtree = await this.subtree(project, id)
            await this.deleteIssue(project, id, actor)
            subtree.forEach(i => gone.add(i))
        })
    }

    async deleteIssue(project: string, id: string, actor = AGENT) {
        id = await this.issueId(project, id)
        await this.issueRow(project, id)
        const subtree = await this.subtree(project, id)
        this.refuse(actor, `Deleting ${id}`, await this.ownedUnder(project, subtree))
        await this.db.transaction(async () => {
            await this.run(`DELETE FROM issue_aliases WHERE project = ? AND issue IN (${subtree.map(() => '?').join(', ')})`, project, ...subtree)
            await this.issuesMoved(project, new Map(subtree.map(old => [old, null])))
            await this.run('DELETE FROM issues WHERE project = ? AND id = ?', project, id)
            await this.touchProject(project)
        })
        this.changed(project)
    }

    /** The owner's decision on a proposal: approved (which commits it, into Todo: approving means it's work), changes asked
     * for, or rejected. It's kept on the issue and left as their comment, so the session on it hears, and
     * the issue goes back to the agent who proposed it. */
    async decide(project: string, id: string, body: unknown, actor = AGENT): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        const row = await this.issueRow(project, id)
        if (!actor.owner) throw forbidden(`Deciding on ${id} is the owner's call; send Orrery-Actor: <owner>`)
        if (!row.proposal) throw badRequest(`${id} isn't a proposal; make it one with PATCH {"proposal": "pending"}`)
        const input = checkInput(body ?? {}, DECISION_FIELDS)
        const decision = input.decision as Decision
        const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null
        const assignee = row.owned ? row.assignee : row.created_by
        // With choices: approving takes the picks (the recommendation where none is sent), and asking for
        // changes can name an option to go further down.
        const choices = JSON.parse(row.choices) as Choice[]
        if (input.picks !== undefined && (decision !== 'approved' || !choices.length)) throw badRequest(`"picks" go with approving a proposal that has choices`)
        if (input.explore !== undefined && decision !== 'changes') throw badRequest(`"explore" goes with asking for changes`)
        let picks: Picks | null = null
        if (decision === 'approved' && choices.length) {
            try {
                picks = resolvePicks(choices, input.picks ? JSON.parse(String(input.picks)) as Picks : {})
            } catch (error) {
                throw badRequest(`Can't approve ${id} with those picks: ${(error as Error).message}`)
            }
        }
        const explore = input.explore ? JSON.parse(String(input.explore)) as {choice: string, option: string} : null
        const explored = explore && choices.find(c => c.key === explore.choice)?.options.find(o => o.key === explore.option)
        if (explore && !explored) throw badRequest(`${id} has no option ${explore.option} in a choice "${explore.choice}"`)
        await this.db.transaction(async () => {
            await this.run('UPDATE issues SET proposal = ?, decided_by = ?, decided_at = ?, decision_note = ?, assignee = ?, picks = ?, explore = ? WHERE project = ? AND id = ?',
                decision, actor.name, stamp(), note, assignee, picks ? JSON.stringify(picks) : null, explore ? JSON.stringify(explore) : null, project, id)
            await this.record(project, id, actor, [['proposal', row.proposal, decision], ['assignee', row.assignee, assignee]])
        })
        const said = picks ? `Approved this proposal with:\n${describePicks(choices, picks)}`
            : explored ? `Asked to explore ${explored.key} (${explored.title}) further: add a choice that goes down it, then put the proposal up again.`
            : DECIDED[decision]
        await this.createComment(project, id, {body: note ? `${said}\n\n${note}` : said}, actor)
        // Approving is the owner saying it's work, so it goes on the roadmap now, keeping who decided and the picks:
        // into Todo while it's still in the backlog, else where its work already took it (started, done).
        if (decision === 'approved') {
            const waiting = (await this.statuses()).find(s => s.id === row.status)?.kind === 'backlog'
            return await this.updateIssue(project, id, waiting ? {proposal: null, status: 'todo'} : {proposal: null}, actor)
        }
        return await this.issue(project, id)
    }

    /** Moves an issue and everything under it to `to`, where they get its ids (KEY-n); the ids they had
     * stay as aliases there. Says the issue's new id. */
    private async moveIssue(from: string, id: string, to: string, parent: Input[string], chunk: Input[string], actor: Actor): Promise<string> {
        await this.projectRow(to)
        const parentId = parent ? await this.issueId(to, String(parent)) : null
        const chunkId = chunk ? await this.chunkId(to, String(chunk)) : null
        if (parentId) await this.issueRow(to, parentId)
        if (parentId && chunkId) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or "parent"`)
        if (chunkId) await this.chunkRow(to, chunkId)
        const subtree = await this.subtree(from, id)
        const marks = subtree.map(() => '?').join(', ')
        // Releases are the source project's, so an issue keeps its release only between projects sharing them.
        const source = await this.releaseSource(from)
        const ships = source && source === await this.releaseSource(to) ? 'ships_in' : 'NULL'
        const moved = await this.db.transaction(async () => {
            // Rows move first and get their new ids and links after, so the foreign keys wait for the commit.
            await this.db.deferConstraints()
            const names = new Map<string, string>()
            for (const old of subtree) names.set(old, await this.nextId(to, 'issue'))
            const links = await this.all<{id: string, parent: string | null}>(`SELECT id, parent FROM issues WHERE project = ? AND id IN (${marks})`, from, ...subtree)
            const comments = await this.all<{id: number, issue: string}>(`SELECT id, issue FROM comments WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            const aliases = await this.all<{alias: string, issue: string}>(`SELECT alias, issue FROM issue_aliases WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            const position = await this.nextPosition('issues', to)
            for (const link of links) {
                const next = names.get(link.id)!
                await this.run(`UPDATE issues SET project = ?, id = ?, parent = ?, chunk = ?, ships_in = ${ships}, position = position + ? WHERE project = ? AND id = ?`,
                    to, next, link.id === id ? parentId : names.get(link.parent!) ?? null, link.id === id && !parentId ? chunkId : null, position, from, link.id)
            }
            for (const comment of comments) await this.run('UPDATE comments SET project = ?, issue = ? WHERE id = ?', to, names.get(comment.issue)!, comment.id)
            for (const [old, next] of names) await this.run('UPDATE issue_events SET project = ?, issue = ? WHERE project = ? AND issue = ?', to, next, from, old)
            await this.record(to, names.get(id)!, actor, [['project', from, to]])
            await this.run(`DELETE FROM issue_aliases WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            for (const {alias, issue} of aliases) await this.run(UPSERT_ISSUE_ALIAS, to, alias, names.get(issue)!)
            for (const [old, next] of names) await this.run(UPSERT_ISSUE_ALIAS, to, old, next)
            await this.issuesMoved(from, names, to)
            await this.run('UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?', stamp(), to, names.get(id)!)
            await this.touchProject(from)
            await this.touchProject(to)
            return names.get(id)!
        })
        this.changed(from)
        this.changed(to)
        return moved
    }

    /** What names an issue by id without a foreign key to it, after the issues in `names` moved from
     * `project` to `to` (under their new id) or went (null): their signals follow them, so a session
     * catching up is told about the issue where it is now, or not at all; a schedule's runs let go of
     * one that went. So no id there comes to mean another issue. */
    private async issuesMoved(project: string, names: Map<string, string | null>, to = project) {
        for (const [old, next] of names) {
            if (next) await this.run('UPDATE signals SET project = ?, issue = ? WHERE project = ? AND issue = ?', to, next, project, old)
            else {
                await this.run('DELETE FROM signals WHERE project = ? AND issue = ?', project, old)
                await this.run('UPDATE schedule_runs SET issue = NULL WHERE issue = ? AND schedule IN (SELECT id FROM schedules WHERE project = ?)', old, project)
            }
        }
    }

    /** The issue's id and every id under it. */
    private async subtree(project: string, id: string): Promise<string[]> {
        const children = await this.all<{id: string}>('SELECT id FROM issues WHERE project = ? AND parent = ?', project, id)
        return [id, ...(await Promise.all(children.map(c => this.subtree(project, c.id)))).flat()]
    }

    // Comments

    async listComments(project: string, issue: string): Promise<Comment[]> {
        issue = await this.issueId(project, issue)
        await this.issueRow(project, issue)
        return (await this.all<CommentRow>(`SELECT c.*, ${ANSWERED} FROM comments c WHERE project = ? AND issue = ? ORDER BY created_at, id`, project, issue)).map(commentOf)
    }

    /** Who changed what on the issue, and when, oldest first. */
    async listActivity(project: string, issue: string): Promise<IssueEvent[]> {
        issue = await this.issueId(project, issue)
        await this.issueRow(project, issue)
        return (await this.all<EventRow>('SELECT * FROM issue_events WHERE project = ? AND issue = ? ORDER BY created_at, id', project, issue)).map(eventOf)
    }

    async comment(project: string, issue: string, id: number): Promise<Comment> {
        issue = await this.issueId(project, issue)
        return commentOf(await this.commentRow(project, issue, id))
    }

    /** An agent's ask assigns the issue to the owner; the owner's answer gives it back to the agent who asked. */
    async createComment(project: string, issue: string, body: unknown, actor = AGENT): Promise<Comment> {
        issue = await this.issueId(project, issue)
        const row = await this.issueRow(project, issue)
        const input = checkInput(body, COMMENT_FIELDS)
        const now = stamp()
        const asker = actor.owner && row.assignee === (await this.ownerId())
            ? (await this.get<{created_by: string}>(`SELECT c.created_by FROM comments c WHERE c.project = ? AND c.issue = ? AND c.asks IS NOT NULL AND c.owned = 0
                AND NOT EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id)
                ORDER BY c.id DESC LIMIT 1`, project, issue))?.created_by
            : undefined
        const assignee = !actor.owner && input.asks ? (await this.ownerId()) : asker
        const id = await this.db.transaction(async () => {
            const {id} = (await this.get<{id: number}>('INSERT INTO comments (project, issue, body, asks, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
                project, issue, String(input.body), nullable(input.asks), actor.name, Number(actor.owner), now, now))!
            if (assignee) {
                await this.run('UPDATE issues SET assignee = ? WHERE project = ? AND id = ?', assignee, project, issue)
                await this.record(project, issue, actor, [['assignee', row.assignee, assignee]])
            }
            await this.touchIssue(project, issue)
            return id
        })
        this.changed(project)
        if (actor.owner) await this.carryComment(project, issue, String(input.body), actor)
        else this.onNotice({...await this.comment(project, issue, id), project, title: (await this.issueRow(project, issue)).title})
        return await this.comment(project, issue, id)
    }

    /** The owner's comments in the project that no agent has answered and no session has had yet,
     * sent to `session` (just connected) to catch up on. Says how many. */
    async carryUnanswered(project: string, session: string): Promise<number> {
        const waiting = await this.all<{issue: string, body: string, created_by: string}>(`
            SELECT c.issue, c.body, c.created_by FROM comments c
            WHERE c.project = ? AND c.owned = 1
              AND NOT EXISTS (SELECT 1 FROM comments a WHERE a.project = c.project AND a.issue = c.issue AND a.owned = 0 AND a.id > c.id)
              AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.project = c.project AND s.issue = c.issue AND s.kind = 'comment'
                              AND s.created_at >= c.created_at AND s.delivered_to != '[]')
            ORDER BY c.created_at LIMIT 10`, project)
        for (const comment of waiting) {
            const row = await this.get<SignalRow>('INSERT INTO signals (project, issue, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
                project, comment.issue, 'comment', comment.body, session, comment.created_by, 1, stamp())
            this.onSignal(signalOf(row!))
        }
        return waiting.length
    }

    /** The owner's comment goes to the session that last worked the issue, so one session answers it; to every
     * session on the project when none has, or that one isn't there to hear it. */
    private async carryComment(project: string, issue: string, body: string, actor: Actor) {
        const target = await this.listeningWorker(project, issue)
        const row = await this.get<SignalRow>('INSERT INTO signals (project, issue, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, issue, 'comment', body, target, actor.name, 1, stamp())
        this.onSignal(signalOf(row!))
    }

    /** The owner's comments are theirs: an agent can't reword them. */
    async updateComment(project: string, issue: string, id: number, body: unknown, actor = AGENT): Promise<Comment> {
        issue = await this.issueId(project, issue)
        const row = await this.commentRow(project, issue, id)
        this.refuse(actor, `Editing comment ${id}`, row.owned ? [`comment ${id}`] : [])
        const input = checkInput(body, COMMENT_FIELDS, true)
        await this.db.transaction(async () => {
            await this.update('comments', 'id = ?', [id], {body: input.body, asks: input.asks})
            await this.touchIssue(project, issue)
        })
        this.changed(project)
        // A session may have read the first version already, so the owner's new words go to it too.
        if (actor.owner && row.owned && input.body !== undefined && String(input.body) !== row.body) {
            await this.carryComment(project, issue, `(Edited: this replaces their earlier comment.)\n\n${input.body}`, actor)
        }
        return await this.comment(project, issue, id)
    }

    async deleteComment(project: string, issue: string, id: number, actor = AGENT) {
        issue = await this.issueId(project, issue)
        const row = await this.commentRow(project, issue, id)
        this.refuse(actor, `Deleting comment ${id}`, row.owned ? [`comment ${id}`] : [])
        await this.db.transaction(async () => {
            await this.run('DELETE FROM comments WHERE id = ?', id)
            await this.touchIssue(project, issue)
        })
        this.changed(project)
    }

    // Docs

    async listDocs(project: string): Promise<DocSummary[]> {
        await this.projectRow(project)
        return await this.docSummaries(project)
    }

    async doc(project: string, id: string): Promise<Doc> {
        return docOf(await this.docRow(project, id))
    }

    async createDoc(project: string, body: unknown, actor = AGENT): Promise<Doc> {
        await this.projectRow(project)
        const input = checkInput(body, DOC_FIELDS)
        const title = String(input.title).trim()
        let id = input.id ? String(input.id) : slugify(title) || 'doc'
        if (input.id) {
            if (await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) throw conflict(`There is already a doc "${id}" in ${project}`)
        } else {
            const base = id
            for (let n = 2; await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id); n++) id = `${base}-${n}`
        }
        const now = stamp()
        await this.db.transaction(async () => {
            await this.run('INSERT INTO docs (project, id, title, body, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, String(input.body ?? ''), Number(input.position ?? await this.nextPosition('docs', project)), actor.name, Number(actor.owner), now, now)
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.doc(project, id)
    }

    /** Creates the doc at `id` or replaces its title and text: how a repo's Markdown file is kept in sync. */
    async putDoc(project: string, id: string, body: unknown, actor = AGENT): Promise<{doc: Doc, created: boolean}> {
        await this.projectRow(project)
        if (!SLUG.test(id)) throw badRequest(`"${id}" isn't a doc id; use lowercase letters, digits and dashes`)
        const input = checkInput(body, DOC_FIELDS)
        if (input.id !== undefined && input.id !== id) throw badRequest(`The body's id "${input.id}" isn't the URL's "${id}"`)
        if (!await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) return {doc: await this.createDoc(project, {...input, id}, actor), created: true}
        return {doc: await this.updateDoc(project, id, {title: input.title, body: input.body ?? '', position: input.position}), created: false}
    }

    async updateDoc(project: string, id: string, body: unknown): Promise<Doc> {
        await this.docRow(project, id)
        const input = checkInput(body, DOC_FIELDS, true)
        if (input.id !== undefined && input.id !== id) throw badRequest("A doc's id can't change")
        await this.db.transaction(async () => {
            await this.update('docs', 'project = ? AND id = ?', [project, id], {
                title: input.title === undefined ? undefined : String(input.title).trim(),
                body: input.body,
                position: input.position,
            })
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.doc(project, id)
    }

    async deleteDoc(project: string, id: string, actor = AGENT) {
        const row = await this.docRow(project, id)
        this.refuse(actor, `Deleting doc "${id}"`, row.owned ? [`doc "${id}"`] : [])
        await this.db.transaction(async () => {
            await this.run('DELETE FROM docs WHERE project = ? AND id = ?', project, id)
            await this.touchProject(project)
        })
        this.changed(project)
    }

    // Releases

    async listReleases(project: string): Promise<Release[]> {
        return (await this.project(project)).releases
    }

    /** The release with its issues: those set for it (a sub-issue's when its parent isn't), each with its sub-issues,
     * as `tasks` (the project's own) and by project in `projects` (with those drawing on it, when it's their source). */
    async release(project: string, version: string): Promise<ReleaseDetail> {
        await this.releaseRow(project, version)
        const own = await this.project(project)
        const drawing = own.releases_from ? [] : await Promise.all((await this.drawingOn(project)).map(id => this.project(id)))
        const parts = [own, ...drawing].map(p => {
            const tasks: Issue[] = []
            const walk = (issues: Issue[]) => issues.forEach(issue => issue.release === version ? tasks.push(issue) : walk(issue.tasks))
            p.board.chunks.forEach(c => walk(c.tasks))
            const {issues, kinds} = p.releases.find(r => r.version === version)!
            return {project: p.id, name: p.name, issues, kinds, tasks}
        })
        // A source's own row counts every project; its part here is only its own issues.
        if (drawing.length) parts[0] = {...parts[0]!, ...tallyReleases([version], [own.board]).get(version)!}
        return {...own.releases.find(r => r.version === version)!, project, tasks: parts[0]!.tasks, projects: parts}
    }

    /** Refuses changing a release from a project that takes its releases from another. */
    private async ownReleases(project: string, action: string) {
        const source = await this.releaseSource(project)
        if (!source) throw badRequest(noReleases(project))
        if (source !== project) throw badRequest(`${project} takes its releases from ${source}; ${action} there: /api/projects/${source}/releases`)
    }

    async createRelease(project: string, body: unknown, actor = AGENT): Promise<ReleaseDetail> {
        await this.ownReleases(project, 'make them')
        const input = checkInput(body, RELEASE_FIELDS)
        const version = String(input.version)
        if (await this.get('SELECT 1 FROM releases WHERE project = ? AND version = ?', project, version)) throw conflict(`There is already a release ${version} in ${project}`)
        const now = stamp()
        await this.db.transaction(async () => {
            const top = (await this.get<{n: number | null}>('SELECT min(position) AS n FROM releases WHERE project = ?', project))?.n ?? 0
            await this.run('INSERT INTO releases (project, version, branch, notes, shipped_on, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, version, nullable(input.branch)?.trim() || null, nullable(input.notes), nullable(input.shipped_on), top - 1, actor.name, Number(actor.owner), now, now)
            if (input.position !== undefined) await this.placeRelease(project, version, Number(input.position))
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.release(project, version)
    }

    async updateRelease(project: string, version: string, body: unknown): Promise<ReleaseDetail> {
        await this.ownReleases(project, 'change them')
        await this.releaseRow(project, version)
        const input = checkInput(body, RELEASE_FIELDS, true)
        if (input.version !== undefined && input.version !== version) throw badRequest("A release's version can't change: make one with the new version and move its issues to it")
        await this.db.transaction(async () => {
            await this.update('releases', 'project = ? AND version = ?', [project, version], {
                branch: input.branch === undefined ? undefined : String(input.branch ?? '').trim() || null,
                notes: input.notes,
                shipped_on: input.shipped_on,
            })
            if (input.position !== undefined) await this.placeRelease(project, version, Number(input.position))
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.release(project, version)
    }

    /** Puts the release at `index` among the project's releases (0 the top, past the end the bottom), numbering
     * them all again from 0. */
    private async placeRelease(project: string, version: string, index: number) {
        const others = (await this.all<{version: string}>('SELECT version FROM releases WHERE project = ? ORDER BY position, created_at DESC', project))
            .map(r => r.version).filter(v => v !== version)
        others.splice(Math.max(0, Math.min(Math.trunc(index), others.length)), 0, version)
        for (const [position, each] of others.entries()) await this.run('UPDATE releases SET position = ? WHERE project = ? AND version = ?', position, project, each)
    }

    /** Its issues stay, set for no release, in every project drawing on it too. */
    async deleteRelease(project: string, version: string, actor = AGENT) {
        await this.ownReleases(project, 'delete them')
        const row = await this.releaseRow(project, version)
        this.refuse(actor, `Deleting release ${version}`, row.owned ? [`release ${version}`] : [])
        await this.db.transaction(async () => {
            await this.run('UPDATE issues SET ships_in = NULL WHERE (project = ? OR project IN (SELECT id FROM projects WHERE releases_from = ?)) AND ships_in = ?', project, project, version)
            await this.run('DELETE FROM releases WHERE project = ? AND version = ?', project, version)
            await this.touchProject(project)
        })
        this.changed(project)
    }

    // Signals

    /** Asks the sessions on the project to focus on the issue (`{note?}` says what for). */
    /** Keeps an image for Markdown to show: `{data, name?}` → where it's served and the Markdown that shows it. */
    async createUpload(body: unknown, actor = AGENT): Promise<Upload> {
        const input = checkInput(body, UPLOAD_FIELDS)
        const base64 = String(input.data).replace(/^data:[^,]*;base64,/, '')
        if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(base64)) throw badRequest('"data" should be the image in base64')
        const bytes = Buffer.from(base64, 'base64')
        if (!bytes.length) throw badRequest('"data" is empty')
        if (bytes.length > UPLOAD_LIMIT) throw badRequest(`The image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; ${UPLOAD_LIMIT / 1024 / 1024} MB at most`)
        const type = IMAGE_TYPES.find(([, test]) => test(bytes))?.[0]
        if (!type) throw badRequest('That isn\'t a PNG, JPEG, GIF or WebP image')
        const name = input.name ? String(input.name).trim().slice(0, 200) || null : null
        const id = randomBytes(12).toString('hex')
        await this.run('INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            id, type, name, bytes.length, bytes, actor.name, Number(actor.owner), stamp())
        const url = `/api/uploads/${id}`
        // Brackets would end the alt text early.
        const alt = (name ?? 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[[\]\\]/g, '')
        return {id, type, size: bytes.length, url, markdown: `![${alt}](${url})`}
    }

    /** An image's bytes and type, as kept. */
    async upload(id: string): Promise<{type: string, data: Buffer}> {
        const row = /^[0-9a-f]{24}$/.test(id) ? await this.get<{type: string, data: Uint8Array}>('SELECT type, data FROM uploads WHERE id = ?', id) : undefined
        if (!row) throw notFound(`No image ${id}`)
        return {type: row.type, data: Buffer.from(row.data)}
    }

    async focus(project: string, issue: string, body: unknown, actor = AGENT): Promise<Signal> {
        issue = await this.issueId(project, issue)
        await this.issueRow(project, issue)
        return await this.sendFocus(project, issue, body, actor)
    }

    /** `focus` for an issue id already resolved and checked. */
    private async sendFocus(project: string, issue: string, body: unknown, actor: Actor): Promise<Signal> {
        const input = checkInput(body ?? {}, SIGNAL_FIELDS)
        const instructions = JSON.stringify(await this.instructionsFor(project, input.instructions))
        const row = await this.get<SignalRow>('INSERT INTO signals (project, issue, kind, note, target, instructions, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, issue, 'focus', nullable(input.note), nullable(input.session), instructions, actor.name, Number(actor.owner), stamp())
        const signal = signalOf(row!)
        if (signal.target) await this.workedBy(project, issue, signal.target)
        this.onSignal(signal)
        return signal
    }

    /** Asks the sessions (or `session`) to work through the chunk's open issues now, or (`status`) its issues of
     * those statuses, or (`release`) those set for a release; `none` is the issues in no chunk, `all` every chunk's. */
    async focusChunk(project: string, chunk: string, body: unknown, actor = AGENT): Promise<Signal> {
        await this.projectRow(project)
        if (chunk !== 'none' && chunk !== 'all') {
            chunk = await this.chunkId(project, chunk)
            await this.chunkRow(project, chunk)
        }
        const input = checkInput(body ?? {}, CHUNK_SIGNAL_FIELDS)
        if (input.status) {
            const status = String(input.status)
            for (const one of status.split(',').map(s => s.trim())) {
                const ids = await this.statusIds(one)
                const statuses = (await this.statuses()).filter(s => ids.includes(s.id))
                if (!statuses.length || statuses.some(s => CLOSED.includes(s.kind))) {
                    throw badRequest(`"status" has "${one}", not an open status (${(await this.statuses()).filter(s => !CLOSED.includes(s.kind)).map(s => s.id).join(', ')}) or kind (backlog, todo, started)`)
                }
            }
        }
        const release = input.release ? (await this.releaseRow(project, String(input.release))).version : null
        const instructions = JSON.stringify(await this.instructionsFor(project, input.instructions))
        const row = await this.get<SignalRow>('INSERT INTO signals (project, chunk, status, release, kind, note, target, instructions, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, chunk, nullable(input.status), release, 'focus', nullable(input.note), nullable(input.session), instructions, actor.name, Number(actor.owner), stamp())
        const signal = signalOf(row!)
        this.onSignal(signal)
        return signal
    }

    /** The id of the project's latest signal, 0 before its first. */
    async lastSignal(project: string): Promise<number> {
        await this.projectRow(project)
        return Number((await this.get<{id: number | null}>('SELECT MAX(id) AS id FROM signals WHERE project = ?', project))?.id ?? 0)
    }

    /** The project's signals after `after` (an id), oldest first; or the latest ones about an issue or a chunk. */
    async listSignals(project: string, after = 0, limit = 50, about?: {issue?: string, chunk?: string}): Promise<Signal[]> {
        await this.projectRow(project)
        if (about?.issue || about?.chunk) {
            const [column, id] = about.issue ? ['issue', await this.issueId(project, about.issue)] : ['chunk', await this.chunkId(project, about.chunk!)]
            return (await this.all<SignalRow>(`SELECT * FROM signals WHERE project = ? AND ${column} = ? ORDER BY id DESC LIMIT ?`, project, id, limit))
                .reverse().map(signalOf)
        }
        return (await this.all<SignalRow>('SELECT * FROM signals WHERE project = ? AND id > ? ORDER BY id LIMIT ?', project, after, limit)).map(signalOf)
    }

    /** What each of the project's sessions is on, for its Sessions page: the open issues it worked last (newest
     * first), and the last `signals` signals that went to it, by its id or, sent to every session, by its name.
     * `ids` are every id a session has gone by (it gets a new one on a `/clear`), its own when left out. */
    async sessionWork(project: string, sessions: {id: string, name: string, ids?: string[]}[], signals = 5): Promise<Record<string, SessionWork>> {
        await this.projectRow(project)
        const open = new Map((await this.listIssues(project)).filter(i => i.kind !== 'proposed' && !CLOSED.includes(i.kind as Kind)).map(i => [i.id, i]))
        const worked = await this.all<{issue: string, session: string}>('SELECT issue, session FROM issue_sessions WHERE project = ? ORDER BY at DESC', project)
        const recent = (await this.all<SignalRow>('SELECT * FROM signals WHERE project = ? ORDER BY id DESC LIMIT 200', project)).map(signalOf)
        return Object.fromEntries(sessions.map(session => {
            const ids = session.ids ?? [session.id]
            const issues = new Set(worked.filter(w => ids.includes(w.session) && open.has(w.issue)).map(w => w.issue))
            return [session.id, {
                issues: [...issues].map(issue => open.get(issue)!).map(({id, title, column, kind, priority}) => ({id, title, column, kind, priority})),
                signals: recent.filter(s => (s.target && ids.includes(s.target)) || (!s.target && s.delivered_to.includes(session.name))).slice(0, signals),
            }]
        }))
    }

    /** Sends a schedule's message to the project's sessions: about no issue, as the schedule's maker. */
    async message(project: string, schedule: number, text: string, actor = AGENT): Promise<Signal> {
        await this.projectRow(project)
        const row = await this.get<SignalRow>('INSERT INTO signals (project, schedule, kind, note, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, schedule, 'message', text, actor.name, Number(actor.owner), stamp())
        const signal = signalOf(row!)
        this.onSignal(signal)
        return signal
    }

    /** Whether a signal of the owner's waits to reach the session (any of its `ids`), for it or for every session. */
    async waiting(project: string, ids: string[]): Promise<boolean> {
        return !!await this.get(`SELECT 1 FROM signals WHERE project = ? AND owned = 1 AND delivered_to = '[]'
            AND (target IS NULL OR target IN (${ids.map(() => '?').join(', ')})) LIMIT 1`, project, ...ids)
    }

    /** The owner's scheduled asks and messages from the last day that no session has heard yet: the next
     * one to connect gets them. */
    async unheardScheduled(project: string): Promise<Signal[]> {
        const since = new Date(Date.now() - 86_400_000).toISOString()
        return (await this.all<SignalRow>(`
            SELECT s.* FROM signals s LEFT JOIN issues i ON i.project = s.project AND i.id = s.issue
            WHERE s.project = ? AND s.owned = 1 AND s.delivered_to = '[]' AND s.created_at >= ?
              AND ((s.kind = 'focus' AND i.schedule IS NOT NULL AND i.status NOT IN (SELECT id FROM statuses WHERE kind IN ('done', 'canceled'))) OR s.kind = 'message')
            ORDER BY s.id`, project, since)).map(signalOf)
    }

    /** Notes that a session got the signal. Two sessions saying so at once both count: the list is only written
     * over if it's still the one read, else read again. */
    async delivered(project: string, id: number, to: string): Promise<Signal> {
        let row: SignalRow | undefined
        let names: string[] = []
        for (let tries = 0; ; tries++) {
            row = await this.get<SignalRow>('SELECT * FROM signals WHERE project = ? AND id = ?', project, id)
            if (!row) throw notFound(`No signal ${id} in ${project}`)
            names = [...new Set([...JSON.parse(row.delivered_to) as string[], to])]
            const {changes} = await this.run('UPDATE signals SET delivered_to = ? WHERE id = ? AND delivered_to = ?', JSON.stringify(names), id, row.delivered_to)
            if (changes || tries === 9) break
        }
        const signal = signalOf({...row, delivered_to: JSON.stringify(names)})
        this.onSignal(signal)
        return signal
    }

    // Import

    /** Loads a roadmap in `docs/roadmap.json`'s format; `replace` first clears the project's chunks and issues.
     * Everything gets the project's ids (chunks 1, 2, …, issues KEY-1, …), the file's ids becoming aliases. */
    async importRoadmap(project: string, roadmap: RoadmapFile, replace = false, actor = AGENT): Promise<Project> {
        await this.projectRow(project)
        if (replace) this.refuse(actor, `Replacing ${project}'s roadmap`, (await this.ownedIn(project)).filter(what => !what.startsWith('project ') && !what.startsWith('doc ')))
        const has = await this.get('SELECT 1 FROM issues WHERE project = ? UNION SELECT 1 FROM chunks WHERE project = ?', project, project)
        if (has && !replace) throw conflict(`${project} already has chunks or issues; import with ?replace=true to replace them`)

        const now = stamp()
        let position = 0
        const insert = async (task: TaskFile, parent: string | null, chunk: string | null) => {
            await this.run(`INSERT INTO issues (project, id, title, status, priority, assignee, labels, notes, parent, chunk, position,
                                          created_by, owned, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, task.id, task.title, await this.resolveStatus(legacyStatus(task.status, task.plan)), task.priority ?? null, task.assignee ?? null, JSON.stringify(task.labels),
                task.notes ?? null, parent, chunk, position++, actor.name, Number(actor.owner), now, now)
            for (const sub of task.tasks) await insert(sub, task.id, null)
        }
        await this.db.transaction(async () => {
            await this.db.deferConstraints()
            if (replace) {
                // Nothing keeps pointing at what's replaced, where an id from the file could take its place.
                const gone = await this.all<{id: string}>('SELECT id FROM issues WHERE project = ?', project)
                await this.issuesMoved(project, new Map(gone.map(({id}) => [id, null])))
                await this.run('DELETE FROM signals WHERE project = ? AND chunk IS NOT NULL', project)
                await this.run('UPDATE schedules SET chunk = NULL WHERE project = ?', project)
                await this.run('DELETE FROM comments WHERE project = ?', project)
                await this.run('UPDATE issues SET parent = NULL, chunk = NULL WHERE project = ?', project)
                await this.run('DELETE FROM issues WHERE project = ?', project)
                await this.run('DELETE FROM chunks WHERE project = ?', project)
                await this.run('DELETE FROM issue_aliases WHERE project = ?', project)
                await this.run('DELETE FROM chunk_aliases WHERE project = ?', project)
            }
            for (const [i, chunk] of roadmap.chunks.entries()) {
                await this.run('INSERT INTO chunks (project, id, title, summary, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    project, chunk.id, chunk.title, chunk.summary || null, i, actor.name, Number(actor.owner), now, now)
                for (const task of chunk.tasks) await insert(task, null, chunk.id)
            }
            await renumber(this.db, project)
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.project(project)
    }

    // Reading

    private async projectOf(row: ProjectRow): Promise<Project> {
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
    private async releasesOf(project: ProjectRow, board: Board): Promise<Release[]> {
        if (project.release_mode === 'none') return []
        const rows = await this.all<ReleaseRow>('SELECT * FROM releases WHERE project = ? ORDER BY position, created_at DESC',
            project.releases_from ?? project.id)
        const boards = project.releases_from ? [board] : [board, ...await Promise.all((await this.drawingOn(project.id)).map(id => this.board(id)))]
        const tally = tallyReleases(rows.map(r => r.version), boards)
        return rows.map(row => ({...releaseOf(row), ...tally.get(row.version)!}))
    }

    private async docSummaries(project: string): Promise<DocSummary[]> {
        return (await this.all<DocRow>('SELECT * FROM docs WHERE project = ? ORDER BY position, created_at', project))
            .map(row => ({id: row.id, title: row.title, created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at}))
    }

    private async board(project: string): Promise<Board> {
        const chunks = await this.all<ChunkRow>('SELECT * FROM chunks WHERE project = ? ORDER BY position, created_at', project)
        const issues = await this.all<IssueRow>('SELECT * FROM issues WHERE project = ? ORDER BY position, created_at', project)
        const comments = new Map((await this.all<{issue: string, n: number}>('SELECT issue, count(*) AS n FROM comments WHERE project = ? GROUP BY issue', project))
            .map(r => [r.issue, r.n]))
        const aliases = async (table: 'issue_aliases' | 'chunk_aliases', column: 'issue' | 'chunk') => {
            const found = new Map<string, string[]>()
            for (const row of await this.all<{alias: string, of: string}>(`SELECT alias, ${column} AS of FROM ${table} WHERE project = ? ORDER BY alias`, project)) {
                found.set(row.of, [...found.get(row.of) ?? [], row.alias])
            }
            return found
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
            aliases: issueAliases.get(row.id) ?? [],
            schedule: row.schedule ?? undefined,
            release: row.ships_in ?? undefined,
            created_by: row.created_by,
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

    private issueRecords(project: Project): IssueRecord[] {
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
        return {...chunk, project: row.project, position: row.position, created_at: row.created_at, updated_at: row.updated_at, issues: tasks.map(t => t.id)}
    }

    /** The issue's id, from its id or an id it had before (an alias). */
    private async issueId(project: string, id: string): Promise<string> {
        if (await this.get('SELECT 1 FROM issues WHERE project = ? AND id = ?', project, id)) return id
        return (await this.get<{issue: string}>('SELECT issue FROM issue_aliases WHERE project = ? AND alias = ?', project, id))?.issue ?? id
    }

    /** The chunk's id, from its number or a name it had before (an alias). */
    private async chunkId(project: string, id: string): Promise<string> {
        if (await this.get('SELECT 1 FROM chunks WHERE project = ? AND id = ?', project, id)) return id
        return (await this.get<{chunk: string}>('SELECT chunk FROM chunk_aliases WHERE project = ? AND alias = ?', project, id))?.chunk ?? id
    }

    /** Hands out the project's next id: KEY-n for an issue, n for a chunk. */
    private async nextId(project: string, kind: 'issue' | 'chunk'): Promise<string> {
        const {key} = await this.projectRow(project)
        const [column, table, aliases] = kind === 'issue' ? ['next_number', 'issues', 'issue_aliases'] as const : ['next_chunk', 'chunks', 'chunk_aliases'] as const
        const name = (n: number) => kind === 'issue' ? `${key}-${n}` : String(n)
        // Each number is taken in one statement, so two writers never get the same one; one an import
        // already used, or that's still an id something had, is skipped.
        for (;;) {
            const {n} = (await this.get<{n: number}>(`UPDATE projects SET ${column} = ${column} + 1 WHERE id = ? RETURNING ${column} - 1 AS n`, project))!
            if (!await this.get(`SELECT 1 FROM ${table} WHERE project = ? AND id = ? UNION SELECT 1 FROM ${aliases} WHERE project = ? AND alias = ?`, project, name(n), project, name(n))) return name(n)
        }
    }

    private async rootOf(project: string, row: IssueRow): Promise<IssueRow> {
        let root = row
        while (root.parent) root = await this.issueRow(project, root.parent)
        return root
    }

    private async projectRow(id: string): Promise<ProjectRow> {
        const row = await this.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
        if (!row) throw notFound(`No project "${id}"`)
        return row
    }

    private async chunkRow(project: string, id: string): Promise<ChunkRow> {
        await this.projectRow(project)
        const row = await this.get<ChunkRow>('SELECT * FROM chunks WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No chunk "${id}" in ${project}`)
        return row
    }

    private async issueRow(project: string, id: string): Promise<IssueRow> {
        await this.projectRow(project)
        const row = await this.get<IssueRow>('SELECT * FROM issues WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No issue ${id} in ${project}`)
        return row
    }

    private async docRow(project: string, id: string): Promise<DocRow> {
        await this.projectRow(project)
        const row = await this.get<DocRow>('SELECT * FROM docs WHERE project = ? AND id = ?', project, id)
        if (!row) throw notFound(`No doc "${id}" in ${project}`)
        return row
    }

    /** The release by its version, in the project's source when it takes its releases from another. */
    private async releaseRow(project: string, version: string): Promise<ReleaseRow> {
        const source = await this.releaseSource(project)
        if (!source) throw badRequest(noReleases(project))
        const row = await this.get<ReleaseRow>('SELECT * FROM releases WHERE project = ? AND version = ?', source, version)
        if (!row) throw notFound(`No release ${version} in ${source}${source === project ? '' : ` (where ${project} takes its releases from)`}; make it with POST /api/projects/${source}/releases`)
        return row
    }

    private async commentRow(project: string, issue: string, id: number): Promise<CommentRow> {
        await this.issueRow(project, issue)
        const row = await this.get<CommentRow>('SELECT * FROM comments WHERE project = ? AND issue = ? AND id = ?', project, issue, id)
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
    private async ownedIn(project: string): Promise<string[]> {
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
    private async ownedUnder(project: string, issues: string[]): Promise<string[]> {
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
    private async record(project: string, issue: string, actor: Actor, changes: [ActivityField, string | null, Input[string]][]) {
        const now = stamp()
        for (const [field, before, after] of changes) {
            if (field !== 'created' && (after === undefined || (after ?? null) === before)) continue
            const [from, to] = field === 'notes' ? [null, null] : [before, nullable(after)]
            await this.run('INSERT INTO issue_events (project, issue, field, before, after, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                project, issue, field, from, to, actor.name, Number(actor.owner), now)
        }
    }

    /** Sets the given fields (undefined ones are left as they are) and the update time. */
    private async update(table: string, where: string, keys: Value[], fields: Input) {
        const set = Object.entries(fields).filter(([, value]) => value !== undefined)
        const columns = [...set.map(([column]) => `${column} = ?`), 'updated_at = ?']
        await this.run(`UPDATE ${table} SET ${columns.join(', ')} WHERE ${where}`, ...set.map(([, value]) => value as Value), stamp(), ...keys)
    }

    private async touchProject(project: string) {
        await this.run('UPDATE projects SET updated_at = ? WHERE id = ?', stamp(), project)
    }

    private async touchIssue(project: string, issue: string) {
        const now = stamp()
        await this.run('UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?', now, project, issue)
        await this.run('UPDATE projects SET updated_at = ? WHERE id = ?', now, project)
    }

    private async nextPosition(table: 'chunks' | 'issues' | 'docs', project: string): Promise<number> {
        return ((await this.get<{n: number | null}>(`SELECT max(position) AS n FROM ${table} WHERE project = ?`, project))?.n ?? -1) + 1
    }

    private run(sql: string, ...params: Value[]) {
        return this.db.run(sql, ...params)
    }

    private get<T>(sql: string, ...params: Value[]) {
        return this.db.get<T>(sql, ...params)
    }

    private all<T>(sql: string, ...params: Value[]) {
        return this.db.all<T>(sql, ...params)
    }
}

function commentOf(row: CommentRow): Comment {
    return {
        id: row.id, issue: row.issue, body: row.body, asks: row.asks ?? undefined, answered: row.asks ? !!row.answered : undefined,
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
    }
}

function eventOf(row: EventRow): IssueEvent {
    return {
        id: row.id, issue: row.issue, field: row.field, before: row.before ?? undefined, after: row.after ?? undefined,
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at,
    }
}

function signalOf(row: SignalRow): Signal {
    return {
        id: row.id, project: row.project, issue: row.issue ?? undefined, chunk: row.chunk ?? undefined, status: row.status ?? undefined, release: row.release ?? undefined, schedule: row.schedule ?? undefined, kind: row.kind, note: row.note ?? undefined,
        target: row.target ?? undefined, delivered_to: JSON.parse(row.delivered_to) as string[], instructions: JSON.parse(row.instructions) as string[], created_by: row.created_by, protected: !!row.owned, created_at: row.created_at,
    }
}

/** How far each release's issues are: an issue set for it counts once, with its sub-issues' work, unless it's under an issue
 * already set for it; a sub-issue set for another release counts there instead, taking its work out of its ancestor's. */
function tallyReleases(versions: string[], boards: Board[]): Map<string, {issues: number, kinds: Kinds}> {
    const tally = new Map(versions.map(v => [v, {issues: 0, kinds: emptyKinds()}]))
    const walk = (issues: Issue[], current: string | undefined) => {
        for (const issue of issues) {
            const release = issue.release ?? current
            const own = issue.release && issue.release !== current ? tally.get(issue.release) : undefined
            if (own) own.issues++
            if (issue.tasks.length) walk(issue.tasks, release)
            else if (release && tally.has(release)) {
                const into = tally.get(release)!.kinds
                for (const kind of Object.keys(into) as (keyof Kinds)[]) into[kind] += issue.kinds[kind]
            }
        }
    }
    boards.forEach(b => b.chunks.forEach(c => walk(c.tasks, undefined)))
    return tally
}

function releaseOf(row: ReleaseRow): Omit<Release, 'issues' | 'kinds'> {
    return {
        version: row.version, branch: row.branch ?? undefined, notes: row.notes ?? undefined, shipped_on: row.shipped_on ?? undefined,
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
    }
}

/** The release mode and source a write asks for, from what the project has: `releases_from` alone makes it
 * `shared`, null gives it its own, and a mode other than `shared` takes none. */
function releaseModeOf(input: Input, mode: ReleaseMode, from: string | null): {mode: ReleaseMode, from: string | null} {
    const sent = input.releases_from === undefined ? undefined : nullable(input.releases_from)
    const asked = input.release_mode as ReleaseMode | undefined
    if (asked === undefined) {
        if (sent) return {mode: 'shared', from: sent}
        if (sent === null && mode === 'shared') return {mode: 'own', from: null}
        return {mode, from}
    }
    if (asked === 'shared') {
        const source = sent === undefined ? from : sent
        if (!source) throw badRequest('Say whose releases it ships in: "releases_from" with the other project\'s id')
        return {mode: asked, from: source}
    }
    if (sent) throw badRequest(`A project with release_mode "${asked}" takes no other's releases; send "shared" with "releases_from", or leave it out`)
    return {mode: asked, from: null}
}

/** Why a project without releases can't have one made or set. */
function noReleases(project: string): string {
    return `${project} has no releases; turn them on with PATCH /api/projects/${project} {"release_mode": "own"}`
}

function docOf(row: DocRow): Doc {
    return {
        id: row.id, project: row.project, title: row.title, body: row.body,
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
    }
}

/** Team tasks as stored: trimmed, each once, none empty. */
function tasksOf(value: Input[string]): string[] {
    return [...new Set(((value ?? []) as string[]).map(t => t.trim()).filter(Boolean))]
}

function nullable(value: Input[string]): string | null {
    return value === undefined || value === null ? null : String(value)
}

/** A preset's fields as sent, trimmed. */
function presetInput(input: Input): {name?: string, text?: string} {
    const trimmed = (value: Input[string]) => value === undefined ? undefined : String(value).trim()
    return {name: trimmed(input.name), text: trimmed(input.text)}
}

function stamp() {
    return new Date().toISOString()
}
