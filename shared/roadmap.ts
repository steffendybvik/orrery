// A project's roadmap as the board draws it: the server reads it from the database, places every
// issue in a column and rolls the columns up into parents and chunks, so the page only draws.

/** The board's columns, in the order work moves through them (Done last). */
export const COLUMNS = ['doing', 'now', 'next', 'later', 'backlog', 'done'] as const
export type Column = (typeof COLUMNS)[number]

export const STATUSES = ['todo', 'doing', 'done'] as const
export type Status = (typeof STATUSES)[number]

/** When an open issue is planned for; none is the backlog. */
export const PLANS = ['now', 'next', 'later'] as const
export type Plan = (typeof PLANS)[number]

/** P0 is urgent. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type Priority = (typeof PRIORITIES)[number]

/** How many leaf issues sit in each column. */
export type Counts = Record<Column, number>

export interface Issue {
    id: string
    title: string
    priority?: Priority
    /** Who's on it: a person, or `claude`. */
    assignee?: string
    labels: string[]
    /** As written; a parent's own status is ignored, its issues decide its column. */
    status: Status
    plan?: Plan
    notes?: string
    column: Column
    /** Its sub-issues' columns; an issue without any counts as one. */
    counts: Counts
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

/** A group of issues (Linear's project milestone). The one with an empty id holds the issues in none. */
export interface Chunk {
    id: string
    title: string
    summary?: string
    /** How much it matters, P0 being urgent. */
    priority?: Priority
    column: Column
    counts: Counts
    /** Names it had before (e.g. `joints`), which still find it. */
    aliases: string[]
    createdBy: string
    protected: boolean
    tasks: Issue[]
}

export interface Board {
    chunks: Chunk[]
    counts: Counts
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
    /** The prefix of the issue ids the server hands out, e.g. `MSH` for `MSH-12`. */
    key: string
    description?: string
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

export const emptyCounts = (): Counts => ({doing: 0, now: 0, next: 0, later: 0, backlog: 0, done: 0})

export const total = (counts: Counts) => COLUMNS.reduce((sum, column) => sum + counts[column], 0)

/** A word to the Claude sessions on a project: `focus` asks one to work on the issue (or work through
 * the chunk) now; `comment` brings the owner's comment on an issue (in `note`) to the session working
 * on it, to answer. */
export interface Signal {
    id: number
    project: string
    /** The issue it's about, or for a focus on a whole chunk, `chunk`. */
    issue?: string
    chunk?: string
    kind: 'focus' | 'comment'
    note?: string
    /** The session it's for; none means every session on the project. */
    target?: string
    /** The names of the sessions it reached. */
    deliveredTo: string[]
    createdBy: string
    /** Sent by the owner. Sessions only act on these. */
    protected: boolean
    createdAt: string
}

/** Where a schedule's issues start: a board column other than Done. */
export const PLACES = ['backlog', 'later', 'next', 'now', 'doing'] as const
export type Place = (typeof PLACES)[number]

/** One time a schedule ran: the issue it made, or why it didn't. */
export interface ScheduleRun {
    at: string
    outcome: 'made' | 'skipped' | 'failed'
    issue?: string
    note?: string
}

/** Recurring work in a project: at each time (`cron` in `timezone`, or once `at`) Orrery makes an issue
 * from it, and with `ask` points the project's listening Claude sessions at it. */
export interface Schedule {
    id: number
    project: string
    title: string
    notes?: string
    cron?: string
    at?: string
    timezone: string
    /** Where its issues start. */
    column: Place
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

/** An agent's comment, as the notification bell lists it. */
export interface Notice extends Comment {
    project: string
    title: string
}
