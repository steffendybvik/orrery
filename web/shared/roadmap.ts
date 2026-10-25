// A project's roadmap as the board draws it: the server reads it from the database, places every
// issue in a column and rolls the columns up into parents and chunks, so the page only draws.
import type {Instruction} from './prompt'

/** What a status means, whatever it's called: Orrery's counts, progress and pages reason about kinds,
 * never names. In board order. */
export const KINDS = ['backlog', 'todo', 'started', 'done', 'canceled'] as const
export type Kind = (typeof KINDS)[number]
/** The kinds an issue is closed in: out of the open counts. Canceled is also out of progress. */
export const CLOSED: readonly Kind[] = ['done', 'canceled']

/** An issue's status, one list for the whole Orrery: its id (`in-review`) is what an issue stores, its
 * name and colour are what the board shows, and its kind is what it means. */
export interface IssueStatus {
    id: string
    name: string
    kind: Kind
    /** A tint's name (`teal`) or a `#rrggbb`. */
    color: string
    position: number
}

/** The statuses a new Orrery starts with. */
export const DEFAULT_STATUSES: Omit<IssueStatus, 'position'>[] = [
    {id: 'backlog', name: 'Backlog', kind: 'backlog', color: 'slate'},
    {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
    {id: 'in-progress', name: 'In progress', kind: 'started', color: 'amber'},
    {id: 'in-review', name: 'In review', kind: 'started', color: 'violet'},
    {id: 'done', name: 'Done', kind: 'done', color: 'green'},
    {id: 'canceled', name: 'Canceled', kind: 'canceled', color: 'slate'},
]

/** Where an issue sits on the board: a status's id, or `proposed` while it's a proposal (not work yet). */
export type Column = string
/** What a column means: a status's kind, or `proposed`. */
export type Place = Kind | 'proposed'

/** Where a proposal stands: waiting on the owner (`pending`), or as they decided. */
export const PROPOSALS = ['pending', 'approved', 'changes', 'rejected'] as const
export type Proposal = (typeof PROPOSALS)[number]
/** What the owner can decide on a proposal. */
export const DECISIONS = ['approved', 'changes', 'rejected'] as const
export type Decision = (typeof DECISIONS)[number]

/** One option of a choice: `A`, `B`, … or a word, with a title and (Markdown) more about it. */
export interface ChoiceOption {
    key: string
    title: string
    body?: string
}

/** A question on a proposal, answered by picking one option or any of them. The agent ticks what it
 * recommends. A choice `from` an option goes further down that option (asked for when the owner explored
 * it), and counts only if that option is picked. */
export interface Choice {
    key: string
    question: string
    pick: 'one' | 'any'
    options: ChoiceOption[]
    recommended: string[]
    from?: {choice: string, option: string}
}

/** The owner's picks: for each choice, the options they ticked. */
export type Picks = Record<string, string[]>

/** P0 is urgent. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type Priority = (typeof PRIORITIES)[number]

/** How many leaf issues sit in each column (a status id, or `proposed`). */
export type Counts = Record<Column, number>
/** The same leaves by what their column means. Proposed ones aren't work yet: they're left out of `total`. */
export type Kinds = Record<Place, number>

export interface Issue {
    id: string
    title: string
    priority?: Priority
    /** Who's on it: a person, or `claude`. */
    assignee?: string
    labels: string[]
    /** A status's id, as written; a parent's own status is ignored, its issues decide its column. */
    status: string
    notes?: string
    /** Set when it's a proposal (with its sub-issues): not work until the owner commits it. */
    proposal?: Proposal
    /** Who last decided on the proposal, when, and what they said. */
    decidedBy?: string
    decidedAt?: string
    decisionNote?: string
    /** A proposal's choices: what the owner decides, the agent's recommendation ticked. */
    choices: Choice[]
    /** The owner's picks when they approved it, choice → options. */
    picks?: Picks
    /** The option the owner asked to explore further when they asked for changes. */
    explore?: {choice: string, option: string}
    column: Column
    /** What its column means. */
    kind: Place
    /** Its sub-issues' columns; an issue without any counts as one. */
    counts: Counts
    kinds: Kinds
    comments: number
    /** Ids it had before (e.g. `MOT-5`), which still find it. */
    aliases: string[]
    /** The schedule that made it, if one did. */
    schedule?: number
    createdBy: string
    /** Made by the owner: no one else can delete it. */
    protected: boolean
    createdAt: string
    updatedAt: string
    tasks: Issue[]
}

/** A group of issues: a milestone. The one with an empty id holds the issues in none. */
export interface Chunk {
    id: string
    title: string
    summary?: string
    /** How much it matters, P0 being urgent. */
    priority?: Priority
    column: Column
    kind: Place
    counts: Counts
    kinds: Kinds
    /** Names it had before (e.g. `joints`), which still find it. */
    aliases: string[]
    createdBy: string
    protected: boolean
    tasks: Issue[]
}

export interface Board {
    chunks: Chunk[]
    counts: Counts
    kinds: Kinds
}

/** A doc without its text, as a project lists it. */
export interface DocSummary {
    id: string
    title: string
    createdBy: string
    protected: boolean
    createdAt: string
    updatedAt: string
}

/** A page of Markdown about the project: an overview, a decision, how to run it. */
export interface Doc extends DocSummary {
    project: string
    body: string
}

/** One app: its details, its board and its docs. */
export interface Project {
    id: string
    name: string
    /** The prefix of the issue ids the server hands out, e.g. `LAR` for `LAR-12`. */
    key: string
    description?: string
    /** Its icon in the sidebar: a Heroicon's name, e.g. `shopping-cart`. */
    icon?: string
    /** Its icon's colour: a tint's name (`teal`) or a `#rrggbb`; none follows the text. */
    iconColor?: string
    /** What its sessions hear when asked to focus on an issue or a chunk, when not the Orrery's (`Settings`). */
    focusPrompt?: string
    chunkPrompt?: string
    /** Its own standing instructions, and the ids of the Orrery's it switches off. */
    instructions: Instruction[]
    muted: string[]
    createdBy: string
    protected: boolean
    createdAt: string
    updatedAt: string
    board: Board
    docs: DocSummary[]
}

/** What an agent's comment waits on the owner for. */
export const ASKS = ['decision', 'feedback'] as const
export type Asks = (typeof ASKS)[number]

export interface Comment {
    id: number
    issue: string
    body: string
    /** It waits on the owner for this, until they comment on the issue after it (`answered`). */
    asks?: Asks
    answered?: boolean
    createdBy: string
    protected: boolean
    createdAt: string
    updatedAt: string
}

/** What an issue's activity records: a field that changed, `created` when it was made, `project` when it
 * moved in from another project. */
export const ACTIVITY_FIELDS = ['created', 'title', 'status', 'priority', 'assignee', 'labels', 'notes', 'chunk', 'parent', 'proposal', 'project'] as const
export type ActivityField = (typeof ACTIVITY_FIELDS)[number]

/** One change to an issue: who set `field` from `before` to `after`, and when. Values are as stored (a
 * status's id, a chunk's id, labels as a JSON list); none means unset. Notes keep no values. */
export interface IssueEvent {
    id: number
    issue: string
    field: ActivityField
    before?: string
    after?: string
    createdBy: string
    protected: boolean
    createdAt: string
}

export const emptyKinds = (): Kinds => ({proposed: 0, backlog: 0, todo: 0, started: 0, done: 0, canceled: 0})

/** The committed issues: every kind but proposed and canceled (what progress is out of). */
export const total = (kinds: Kinds) => kinds.backlog + kinds.todo + kinds.started + kinds.done

/** The open issues: committed and not closed. */
export const open = (kinds: Kinds) => kinds.backlog + kinds.todo + kinds.started

/** A word to the Claude sessions on a project: `focus` asks one to work on the issue (or work through
 * the chunk) now; `comment` brings the owner's comment on an issue (in `note`) to the session working
 * on it, to answer; `message` is a schedule's message (in `note`), about no issue. */
export interface Signal {
    id: number
    project: string
    /** The issue it's about, or for a focus on a whole chunk, `chunk`. */
    issue?: string
    chunk?: string
    /** For a chunk: only its issues of this status (an id, or a kind), not all its open ones. */
    status?: string
    /** The schedule that sent it (a message). */
    schedule?: number
    kind: 'focus' | 'comment' | 'message'
    note?: string
    /** The session it's for; none means every session on the project. */
    target?: string
    /** The names of the sessions it reached. */
    deliveredTo: string[]
    /** The standing instructions picked for a focus, as said. */
    instructions: string[]
    createdBy: string
    /** Sent by the owner. Sessions only act on these. */
    protected: boolean
    createdAt: string
}

/** One time a schedule ran: the issue it made, or why it didn't. */
export interface ScheduleRun {
    at: string
    /** `made` an issue, `sent` a message, or `skipped` / `failed` (with why). */
    outcome: 'made' | 'sent' | 'skipped' | 'failed'
    issue?: string
    note?: string
}

/** Recurring work in a project: at each time (`cron` in `timezone`, or once `at`) Orrery makes an issue
 * from it, and with `ask` points the project's listening Claude sessions at it; or, as a `message`
 * schedule, sends `notes` to the sessions without an issue. */
export interface Schedule {
    id: number
    project: string
    kind: 'issue' | 'message'
    title: string
    /** The issue's description, or the message. */
    notes?: string
    cron?: string
    at?: string
    timezone: string
    /** Where its issues start: a status's id (not a closed one). */
    column: string
    chunk?: string
    priority?: Priority
    labels: string[]
    ask: boolean
    /** Skips a run while the issue from the last one isn't done. */
    skipOpen: boolean
    enabled: boolean
    /** When it runs next; none once it's paused or a one-off has run. */
    nextRun?: string
    /** The latest runs, newest first. */
    runs: ScheduleRun[]
    createdBy: string
    protected: boolean
    createdAt: string
    updatedAt: string
}

/** The tints a page can take on: a few named colours, or any `#rrggbb`. */
export const TINTS = {slate: '#64748b', blue: '#3b82f6', teal: '#14b8a6', green: '#22c55e', amber: '#f59e0b', rose: '#f43f5e', violet: '#8b5cf6'} as const

/** This Orrery's own settings, not a project's. */
/** Whose Orrery it is: their name as the page shows it, and the `Orrery-Actor` id it makes. */
export interface Owner {
    /** The id: the name in lowercase snake case (`skoll_fenrisson`); `owner` until they give one. */
    name: string
    display: string
    /** Whether they've given their name (the page asks on first open). */
    named: boolean
}

export interface Settings {
    /** The colour the page's background takes on, so one Orrery looks unlike another; none by default. */
    tint: string | null
    /** The issue statuses, in board order. */
    statuses: IssueStatus[]
    /** What a session hears when asked to focus on an issue, or to work through a chunk; none is the default
     * (`DEFAULT_FOCUS_PROMPT`, `DEFAULT_CHUNK_PROMPT`). A project can have its own. */
    focusPrompt: string | null
    chunkPrompt: string | null
    /** Lines added to every focus, such as `commit whenever a piece works`. */
    instructions: Instruction[]
}

/** What a Claude session is doing, as its hooks last said: `waiting` is waiting on the owner. */
export const SESSION_STATES = ['starting', 'working', 'idle', 'waiting'] as const
export type SessionState = (typeof SESSION_STATES)[number]

/** A Claude window working on a project, known from its hooks and its channel. */
export interface Session {
    /** Claude Code's session id. */
    id: string
    project: string
    /** `ORRERY_SESSION` when it was started, else "<project> <n>". */
    name: string
    cwd?: string
    state: SessionState
    /** When it got into that state. */
    since: string
    startedAt: string
    /** Its channel is connected, so a signal reaches it. */
    listening: boolean
}

/** An agent's comment, as the notification bell and page list it. */
export interface Notice extends Comment {
    project: string
    title: string
    /** Taken out of the bell; only `GET /notices?list=cleared` lists these. */
    cleared?: boolean
}

/** The lists of notices: the bell's, and the notifications page's tabs. */
export const NOTICE_LISTS = ['bell', 'waiting', 'inbox', 'cleared'] as const
export type NoticeList = (typeof NOTICE_LISTS)[number]

/** A secret as anyone sees it: never its value. Agents put `{{secret:NAME}}` in a request Orrery makes for them. */
export interface Secret {
    name: string
    /** Its last 4 characters, to tell one value from another. */
    last4: string
    /** The hosts it may be sent to; Orrery refuses any other. */
    hosts: string[]
    /** The projects that may use it; null for any. */
    projects: string[] | null
    createdBy: string
    createdAt: string
    updatedAt: string
    lastUsed: SecretUse | null
}

/** One request a secret went out in, kept without the value. */
export interface SecretUse {
    id: number
    secret: string
    method: string
    host: string
    /** The path as the agent wrote it, placeholders and all. */
    path: string
    project: string | null
    issue: string | null
    /** The status that came back, or null when it never got one (`error` says why). */
    status: number | null
    error: string | null
    createdBy: string
    createdAt: string
}
