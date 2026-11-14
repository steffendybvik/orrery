// This orrery's own settings: its owner, the sessions it may start, its database.
import type {Instruction} from '../prompt'
import type {IssueStatus} from './board'
import type {WorkKind} from './work-kinds'

/** The tints a page can take on: a few named colours, or any `#rrggbb`. */
export const TINTS = {slate: '#64748b', blue: '#3b82f6', teal: '#14b8a6', green: '#22c55e', amber: '#f59e0b', rose: '#f43f5e', violet: '#8b5cf6'} as const

/** This orrery's own settings, not a project's. */
/** Someone on this orrery (`GET /api/people`): the owner, or a member they added. `id` is what a session sets as
 * `ORRERY_PERSON`, and `removed_at` when they were removed: their name stays on history. */
export type KeyKind = 'agent' | 'person'
/** A key as it's listed (ORR-664): never the key itself, which shows once, as it's made. */
export interface KeyRecord {
    id: string
    person: string
    kind: KeyKind
    name: string
    created_at: string
    last_used_at?: string
    revoked_at?: string
}

/** A browser's login as it's listed (ORR-838): `id` is a short part of its hash, never what's in the cookie. `name` says
 * how it was made, such as a phone's QR code; `current` marks the browser asking. Older logins have no dates. */
export interface LoginRecord {
    id: string
    person: string
    name?: string
    created_at?: string
    last_used_at?: string
    expires_at: string
    current?: boolean
}

export interface Person {
    id: string
    name: string
    role: 'owner' | 'member'
    created_at: string
    removed_at?: string
}

/** Someone on a board (ORR-654): its one holder (`owner`), who says who else is on it, or a `member`. */
export interface BoardMember {
    person: string
    name: string
    role: 'owner' | 'member'
    created_at: string
}

/** Whose orrery it is: their name as the page shows it, and the `Orrery-Actor` id it makes. */
export interface Owner {
    /** The id: the name in lowercase snake case (`skoll_fenrisson`); `owner` until they give one. */
    name: string
    display: string
    /** Whether they've given their name (the page asks on first open). */
    named: boolean
}

/** When a repo came onto the launcher's list, when it wasn't by `--install`: its channel picked it up (ORR-599, ORR-605),
 * or Connect a repo added it (ORR-774). */
export interface RepoAdded {
    picked_at?: string
    connected_at?: string
}

/** A folder a project's launcher serves it from. */
export interface LauncherRepo extends RepoAdded {
    dir: string
}

/** The sessions orrery may start, the owner's one setting for every project: at most `limit` running at once on each, each running until it's stopped,
 * or for `minutes` when set. `idle_minutes` stops one that has sat idle with nothing to do for that long. Neither
 * stops a session mid-work: it waits until the session is idle with nothing in progress or waiting. `min` keeps that many
 * running over every project: one stopped as done (time up, idle too long) is replaced by one like it, with a fresh context;
 * one the owner stops isn't. `on_signal: false` stops the owner's work that finds nobody listening on a project from starting
 * one there: it waits for a session they start (Start session, or Focus on this, which asks for one). Missing is true. */
export interface Starts {
    limit: number
    min?: number
    minutes?: number
    idle_minutes?: number
    on_signal?: boolean
}

/** The terminal apps Watch can open (on macOS; elsewhere the system's own terminal opens), by their setting. */
export const TERMINALS = {terminal: 'Terminal', iterm: 'iTerm2', warp: 'Warp', ghostty: 'Ghostty'} as const
export type TerminalApp = keyof typeof TERMINALS

/** The AI agents someone can say they run when they connect (ORR-1075), by their setting: those with a launcher adapter
 * (`channel/agents.mjs`), and `other` for one with none yet, which meets orrery through its REST API and MCP tools. */
export const AGENT_CHOICES = {claude: 'Claude Code', other: 'Another agent'} as const
export type AgentChoice = keyof typeof AGENT_CHOICES

/** Where this orrery keeps its data, as App settings shows it (read only): a SQLite file's path, or a Postgres
 * database as `user@host:port/name`, never its password. */
export interface DatabaseInfo {
    kind: 'sqlite' | 'postgres'
    where: string
    /** Under Docker, where the SQLite file is on the computer (from `ORRERY_DATA`), or the Docker volume it's in
     * instead; `where` stays the path orrery opens, inside the container. */
    host?: string
    volume?: string
    /** How big it is, in bytes: a SQLite file with its `-wal`, or the Postgres database; none when it can't be read. */
    size?: number
}

export interface Settings {
    /** This orrery's id, made once when it first starts (`orr_7f3a9c`): a channel set up for it checks it's
     * talking to the same orrery (ORRERY_ID), whatever its address. */
    id: string
    /** Which orrery this is (`personal`, `work`), as it's run; a channel serving it is named `orrery-<environment>` (`GET /api/machine` only, ORR-954). */
    environment?: string
    /** Where its data is (`GET /api/machine` only, ORR-954). */
    database?: DatabaseInfo
    /** The colour the page's background takes on, so one orrery looks unlike another; none by default. */
    tint: string | null
    /** The issue statuses, in board order. */
    statuses: IssueStatus[]
    /** What a session hears when asked to focus on an issue, or to work through a milestone; none is the default
     * (`DEFAULT_FOCUS_PROMPT`, `DEFAULT_MILESTONE_PROMPT`). A project can have its own. */
    focus_prompt: string | null
    milestone_prompt: string | null
    /** Lines added to every focus, such as `commit whenever a piece works`. */
    instructions: Instruction[]
    /** The owner's handle in an issue's reference (`orrery-<handle>: DOC-132`), such as their GitHub login;
     * none uses their id. */
    handle: string | null
    /** This server's random id, in the full form of what belongs to it, not a board: `pst-12-x7k2m9qd`. A copy of the database keeps it. */
    uid: string
    /** Where the team's tracker shows a task, with `{id}` for its id: `https://tracker.example.com/issue/{id}`. */
    tracker: string | null
    /** Whether orrery starts sessions itself, for any project whose repo has a launcher, and within what; none
     * while the owner hasn't let it. */
    starts: Starts | null
    /** The terminal app Watch opens a session orrery started in, on its launcher's machine. */
    terminal: TerminalApp
    /** The AI agent the owner runs (ORR-1075), which Getting started and Connect an agent open on: Claude Code unless
     * they picked another. */
    agent: AgentChoice
    /** Whether a proposal waiting on the owner (pending, or changes asked for) is theirs alone until they decide:
     * an agent can't start it, change its status, assign it or put it in a release. On unless the owner turns it off. */
    restrict_proposals: boolean
    /** Shows what's for looking into problems: the Events page, and a notice in the bell for each new kind of error.
     * Off by default; errors are recorded either way, what orrery did only while it's on. */
    advanced: boolean
    /** Counts the owner's own use of features, for App settings' Usage (ORR-881). Off unless turned on. */
    count_use: boolean
    /** The kinds of work, highest-ranked first, each with the model a session for it starts on (ORR-868): the owner's,
     * else orrery's own (`WORK_KINDS`). An issue's kind is its highest-ranked label's. */
    work_kinds: WorkKind[]
    /** Projects the sidebar lists first, by id, and projects it folds away under Hidden (ORR-836). Only where
     * they show: a hidden project's issues, sessions and schedules carry on, and its pages still open. A project
     * is never both: hidden wins. */
    starred: string[]
    hidden: string[]
}
