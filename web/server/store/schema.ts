// The store's records and rows, the fields each write takes, and turning rows into records.
import type {ActivityField, Asks, Board, Chunk, Comment, Counts, Decision, Doc, Issue, IssueEvent, Kind, Kinds, Priority, Project, Proposal, Release, ReleaseMode, Signal} from '#shared/roadmap'
import {ASKS, DECISIONS, KINDS, PRIORITIES, RELEASE_MODES, TERMINALS, TINTS, emptyKinds} from '#shared/roadmap'
import type {Field, Input} from '../utils/input'
import {badRequest, isObject} from '../utils/input'
import {parseChoices} from '../utils/choices'
import {LEGACY_PLANS} from '../utils/roadmap'

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
export const BULK_FIELDS = ['status', 'priority', 'assignee', 'chunk', 'release']

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

/** Who's asking, by the name it gives; `owner` when that's the owner's name; `untrusted` for an untrusted schedule's
 * session, whose writes set no schedule off. */
export interface Actor {
    name: string
    owner: boolean
    untrusted?: boolean
    /** The owner, through their chat: what they allowed or sent from a request it asked (chats.ts `answer`). */
    via?: 'chat'
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
export interface ProjectRow extends Made {
    id: string, name: string, key: string, description: string | null, icon: string | null, icon_color: string | null, next_number: number, next_chunk: number,
    focus_prompt: string | null, chunk_prompt: string | null, instructions: string, muted: string, starts: string | null, repo: string | null,
    release_mode: ReleaseMode, releases_from: string | null
}
export interface ChunkRow extends Made { project: string, id: string, title: string, summary: string | null, priority: Priority | null, position: number }
export interface IssueRow extends Made {
    project: string, id: string, title: string, status: string, priority: Priority | null,
    assignee: string | null, labels: string, external: string, notes: string | null,
    parent: string | null, chunk: string | null, position: number, schedule: number | null,
    proposal: Proposal | null, decided_by: string | null, decided_at: string | null, decision_note: string | null,
    choices: string, picks: string | null, explore: string | null, ships_in: string | null
}
export interface CommentRow extends Made { id: number, project: string, issue: string, body: string, asks: Asks | null, answered?: number }
export interface EventRow { id: number, project: string, issue: string, field: ActivityField, before: string | null, after: string | null, created_by: string, owned: number, created_at: string }
export interface DocRow extends Made { project: string, id: string, title: string, body: string, position: number }
export interface ReleaseRow extends Made { project: string, version: string, branch: string | null, notes: string | null, frozen_on: string | null, shipped_on: string | null, position: number }
export interface PresetRow { id: number, project: string | null, name: string, text: string, icon: string | null, color: string | null, default_key: string | null, created_at: string, updated_at: string }
export interface SignalRow { id: number, project: string, issue: string | null, chunk: string | null, status: string | null, release: string | null, schedule: number | null, kind: 'focus' | 'comment' | 'message', note: string | null, preset: string | null, via: string | null, target: string | null, delivered_to: string, instructions: string, created_by: string, owned: number, created_at: string }

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A named tint or any `#rrggbb`: the page's tint, a project icon's colour. */
const TINT: Field = {type: 'string', nullable: true, pattern: new RegExp(`^(${Object.keys(TINTS).join('|')}|#[0-9a-fA-F]{6})$`), hint: `use ${Object.keys(TINTS).join(', ')} or a colour like #3b82f6`}
const KEY = /^[A-Z][A-Z0-9]{0,9}$/
/** A release's version: `1.0.0`, `1.0.0-rc.2`, `2026.10`, `v2`; it goes in URLs as it is. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/

export const PROJECT_FIELDS: Record<string, Field> = {
    id: {type: 'string', pattern: SLUG, hint: 'use lowercase letters, digits and dashes'},
    name: {type: 'string', required: true},
    key: {type: 'string', pattern: KEY, hint: 'use capitals and digits, starting with a capital, e.g. GRE'},
    description: {type: 'string', nullable: true},
    icon: {type: 'string', nullable: true, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/, hint: "use a Heroicon's name, e.g. shopping-cart"},
    icon_color: TINT,
    /** The owner's: what the project's sessions hear when asked to focus (none is the orrery's). */
    focus_prompt: {type: 'string', nullable: true},
    chunk_prompt: {type: 'string', nullable: true},
    instructions: {type: 'lines', nullable: true},
    /** Ids of the orrery's standing instructions the project switches off. */
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
export const PROMPT_FIELDS = ['focus_prompt', 'chunk_prompt', 'instructions', 'muted']

// No `id` on chunks and issues: orrery numbers them in their project (chunks 1, 2, …, issues KEY-1, …).
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
    /** Its tasks on the team's tracker: ids (`ENG-1567`) or full URLs. */
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
    frozen_on: {type: 'string', nullable: true, pattern: /^\d{4}-\d{2}-\d{2}$/, hint: 'use a day, YYYY-MM-DD'},
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
export const DECIDED: Record<Decision, string> = {approved: 'Approved this proposal.', changes: 'Asked for changes to this proposal.', rejected: 'Rejected this proposal.'}

export const SIGNAL_FIELDS: Record<string, Field> = {
    note: {type: 'string', nullable: true},
    /** A session id, or `*` for every session on the project; left out, one session orrery picks gets it. */
    session: {type: 'string', nullable: true},
    /** The standing instructions to add, by id (the orrery's or the project's); left out, those ticked by default. */
    instructions: {type: 'strings', nullable: true},
}

/** A chunk's focus can be narrowed to its issues of some open statuses, `{status: 'todo,started'}` (ids or kinds),
 * and to those set for a release. */
export const CHUNK_SIGNAL_FIELDS: Record<string, Field> = {
    ...SIGNAL_FIELDS,
    status: {type: 'string', nullable: true},
    release: {type: 'string', nullable: true},
}

export const STATUS_FIELDS = {
    id: {type: 'string', pattern: SLUG, hint: 'use lowercase letters, digits and dashes'},
    name: {type: 'string', required: true},
    kind: {type: 'string', values: KINDS, required: true},
    color: {...TINT, nullable: false},
    position: {type: 'number'},
} satisfies Record<string, Field>

/** What agents sent before statuses, and what they mean now. */
export const LEGACY_KINDS: Record<string, Kind> = {doing: 'started', now: 'todo', next: 'todo', later: 'todo'}

export const SETTINGS_FIELDS: Record<string, Field> = {
    tint: TINT,
    focus_prompt: {type: 'string', nullable: true},
    chunk_prompt: {type: 'string', nullable: true},
    instructions: {type: 'lines', nullable: true},
    tracker: {type: 'string', nullable: true, pattern: /^https?:\/\/\S*\{id\}\S*$/, hint: 'use the web address of a task with {id} where its id goes, e.g. https://tracker.example.com/issue/{id}'},
    handle: {type: 'string', nullable: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/, hint: 'use letters, digits, dots, dashes and underscores, e.g. your GitHub login'},
    /** `{limit, minutes?, idle_minutes?}` lets orrery start sessions, for any project with a launcher; null stops that. */
    starts: {type: 'json', nullable: true, parse: parseStarts},
    /** The terminal app Watch opens; null is Terminal. */
    terminal: {type: 'string', nullable: true, values: Object.keys(TERMINALS)},
    /** Keeps agents off a proposal while it waits on the owner; false lets them. */
    restrict_proposals: {type: 'boolean'},
    /** Shows the Events page and error notices in the bell, and records what orrery did as well as its errors. */
    advanced: {type: 'boolean'},
}

/** A preset's name and its text, both needed; its badge's icon and colour, neither. */
export const PRESET_FIELDS: Record<string, Field> = {
    name: {type: 'string', required: true},
    text: {type: 'string', required: true},
    icon: {type: 'string', nullable: true, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/, hint: "use a Heroicon's name, e.g. shield-check"},
    color: TINT,
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

/** The images orrery takes, told by their first bytes rather than what the sender says (no SVG: it can run script). */
export const IMAGE_TYPES: [string, (bytes: Buffer) => boolean][] = [
    ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
    ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ['image/gif', b => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1'))],
    ['image/webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
]

/** Whether the owner has commented on the issue since comment `c`. */
export const SINCE = 'EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id)'
export const ANSWERED = `${SINCE} AS answered`
/** Comment `c` is an agent's question the owner hasn't answered yet: what its issue waits on them for. */
export const OPEN_ASK = `c.asks IS NOT NULL AND c.owned = 0 AND NOT ${SINCE}`


export function commentOf(row: CommentRow): Comment {
    return {
        id: row.id, issue: row.issue, body: row.body, asks: row.asks ?? undefined, answered: row.asks ? !!row.answered : undefined,
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
    }
}

export function eventOf(row: EventRow): IssueEvent {
    return {
        id: row.id, issue: row.issue, field: row.field, before: row.before ?? undefined, after: row.after ?? undefined,
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at,
    }
}

export function signalOf(row: SignalRow): Signal {
    return {
        id: row.id, project: row.project, issue: row.issue ?? undefined, chunk: row.chunk ?? undefined, status: row.status ?? undefined, release: row.release ?? undefined, schedule: row.schedule ?? undefined, kind: row.kind, note: row.note ?? undefined, preset: row.preset ?? undefined, ...row.via === 'chat' ? {via: 'chat' as const} : {},
        target: row.target ?? undefined, delivered_to: JSON.parse(row.delivered_to) as string[], instructions: JSON.parse(row.instructions) as string[], created_by: row.created_by, protected: !!row.owned, created_at: row.created_at,
    }
}

/** How far each release's issues are: an issue set for it counts once, with its sub-issues' work, unless it's under an issue
 * already set for it; a sub-issue set for another release counts there instead, taking its work out of its ancestor's. */
export function tallyReleases(versions: string[], boards: Board[]): Map<string, {issues: number, kinds: Kinds}> {
    const tally = new Map(versions.map(v => [v, {issues: 0, kinds: emptyKinds()}]))
    const walk = (issues: Issue[], current: string | undefined) => {
        for (const issue of issues) {
            const release = issue.release ?? current
            const own = issue.release && issue.release !== current ? tally.get(issue.release) : undefined
            if (own) own.issues++
            if (issue.tasks.length) walk(issue.tasks, release)
            else {
                const into = release ? tally.get(release)?.kinds : undefined
                if (into) for (const kind of Object.keys(into) as (keyof Kinds)[]) into[kind] += issue.kinds[kind]
            }
        }
    }
    boards.forEach(b => b.chunks.forEach(c => walk(c.tasks, undefined)))
    return tally
}

export function releaseOf(row: ReleaseRow): Omit<Release, 'issues' | 'kinds'> {
    return {
        version: row.version, branch: row.branch ?? undefined, notes: row.notes ?? undefined, frozen_on: row.frozen_on ?? undefined, shipped_on: row.shipped_on ?? undefined,
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
    }
}

/** The release mode and source a write asks for, from what the project has: `releases_from` alone makes it
 * `shared`, null gives it its own, and a mode other than `shared` takes none. */
export function releaseModeOf(input: Input, mode: ReleaseMode, from: string | null): {mode: ReleaseMode, from: string | null} {
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
export function noReleases(project: string): string {
    return `${project} has no releases; turn them on with PATCH /api/projects/${project} {"release_mode": "own"}`
}

/** A doc's first paragraph as plain text (no headings, code, pictures or Markdown marks), cut to about 160 characters. */
export function summaryOf(body: string): string {
    let fenced = false
    const lines: string[] = []
    for (const line of body.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
        else if (fenced || /^\s*(#|<!--|\||---|\*\*\*)/.test(line) || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) {
            if (lines.length) break
        } else if (!line.trim()) {
            if (lines.length) break
        } else lines.push(line)
    }
    const text = lines.join(' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s*(>|[-*+]|\d+\.)\s+/, '')
        .replace(/[*_`]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    if (text.length <= 160) return text
    const cut = text.slice(0, 160)
    return `${cut.slice(0, cut.lastIndexOf(' ') > 100 ? cut.lastIndexOf(' ') : 160).replace(/[,;:.]$/, '')}…`
}

/** The text around the first of `words` (lowercase) in a doc's text, on one line, about 160 characters; empty when
 * only its title has them. */
export function matchOf(body: string, words: string[]): string {
    const lower = body.toLowerCase()
    const at = Math.min(...words.map(word => lower.indexOf(word)).filter(i => i >= 0))
    if (!Number.isFinite(at)) return ''
    let start = Math.max(0, at - 60)
    let end = Math.min(body.length, at + 100)
    if (start > 0) start = body.indexOf(' ', start) + 1 || start
    if (end < body.length) end = body.lastIndexOf(' ', end) > at ? body.lastIndexOf(' ', end) : end
    return `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '…' : ''}`
}

export function docOf(row: DocRow): Doc {
    return {
        id: row.id, project: row.project, title: row.title, summary: summaryOf(row.body), body: row.body,
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
    }
}

/** Team tasks as stored: trimmed, each once, none empty. */
export function tasksOf(value: Input[string]): string[] {
    return [...new Set(((value ?? []) as string[]).map(t => t.trim()).filter(Boolean))]
}

export function nullable(value: Input[string]): string | null {
    return value === undefined || value === null ? null : String(value)
}

/** A preset's fields as sent, trimmed. */
/** A preset's name and text, trimmed; one that's only spaces is refused, as an empty one is. */
export function presetInput(input: Input): {name?: string, text?: string} {
    const trimmed = (key: 'name' | 'text') => {
        if (input[key] === undefined) return undefined
        const value = String(input[key]).trim()
        if (!value) throw badRequest(`"${key}" needs more than spaces`)
        return value
    }
    return {name: trimmed('name'), text: trimmed('text')}
}

export function stamp() {
    return new Date().toISOString()
}
