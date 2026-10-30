// This orrery's own settings: its owner, the sessions it may start, its database and backups.
import type {Instruction} from '../prompt'
import type {IssueStatus} from './board'

/** The tints a page can take on: a few named colours, or any `#rrggbb`. */
export const TINTS = {slate: '#64748b', blue: '#3b82f6', teal: '#14b8a6', green: '#22c55e', amber: '#f59e0b', rose: '#f43f5e', violet: '#8b5cf6'} as const

/** This orrery's own settings, not a project's. */
/** Whose orrery it is: their name as the page shows it, and the `Orrery-Actor` id it makes. */
export interface Owner {
    /** The id: the name in lowercase snake case (`skoll_fenrisson`); `owner` until they give one. */
    name: string
    display: string
    /** Whether they've given their name (the page asks on first open). */
    named: boolean
}

/** A folder a project's launcher serves it from, and when its channel picked it up there (ORR-599), when it did rather
 * than `--install` (ORR-605). */
export interface LauncherRepo {
    dir: string
    picked_at?: string
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

/** Where this orrery keeps its data, as App settings shows it (read only): a SQLite file's path, or a Postgres
 * database as `user@host:port/name`, never its password; the folder it's backed up to, if any, and when the
 * latest backup there was made. */
/** A copy in the backup folder (`GET /api/backups`, ORR-448): the latest, a daily one, or one taken before an upgrade
 * or a restore (or set aside as another orrery's), with when it was written, its size in bytes, and the orrery it's a
 * copy of: its id, the name it ran under (`ORRERY_ENVIRONMENT`) and its projects, when it can be read. */
export interface Snapshot {
    name: string
    kind: 'latest' | 'daily' | 'before'
    at: string
    size: number
    of?: string
    environment?: string
    projects?: number
}

/** The backups to restore from, and what's needed to offer them (`GET /api/backups`). */
export interface Backups {
    snapshots: Snapshot[]
    /** A new orrery's database: no projects, no owner. */
    fresh: boolean
    /** Whether the app can restore one: a SQLite orrery, not set to Postgres by ORRERY_DATABASE. */
    restorable: boolean
    environment: string
    docker: boolean
}

export interface DatabaseInfo {
    kind: 'sqlite' | 'postgres'
    where: string
    /** Under Docker, where the SQLite file is on the computer (from `ORRERY_DATA`), or the Docker volume it's in
     * instead; `where` stays the path orrery opens, inside the container. */
    host?: string
    volume?: string
    /** Where it's backed up to: a folder, or a Postgres database as `user@host:port/name` (`backup_kind`). */
    backup?: string
    /** `postgres` when the backups go into a Postgres database (ORR-427); a folder otherwise. */
    backup_kind?: 'postgres'
    /** The same for the backup folder (from `ORRERY_BACKUP`). */
    backup_host?: string
    backup_volume?: string
    backed_up_at?: string
    /** Why the latest backup failed and when, until one works again (ORR-448). */
    backup_failed?: {at: string, message: string}
    /** In Docker, backups go to the default folder (ORRERY_BACKUP isn't set), on the same computer (ORR-448). */
    backup_local?: true
    /** How big it is, in bytes: a SQLite file with its `-wal`, or the Postgres database; none when it can't be read. */
    size?: number
    /** The backup folder's files together, in bytes. */
    backup_size?: number
    /** Whether the owner can move it from App settings: not when NUXT_DATABASE (ORRERY_DATABASE) is Postgres. */
    movable?: boolean
    /** Whether it was moved there from App settings, rather than set as orrery starts. */
    moved?: boolean
    /** What the owner can set about backups in App settings: `folder`, whether they run and where; `switch`, only
     * whether they run (in Docker, ORRERY_BACKUP sets the folder). None when NUXT_DATABASE is Postgres. */
    backups_settable?: 'folder' | 'switch'
    /** The owner turned backups off. */
    backups_off?: boolean
    /** The folder the owner chose for backups instead of NUXT_BACKUP_DIR, kept while they're off too. */
    backup_folder?: string
    /** The Postgres database the owner chose for backups, without its password, kept while they're off too. */
    backup_postgres?: string
    /** NUXT_BACKUP_DIR, the folder orrery is given as it starts. */
    backup_default?: string
    /** How often it backs up: a few seconds after a change, or at most every 15 minutes, hour or day (ORR-445). */
    backup_every?: 'change' | '15m' | 'hour' | 'day'
    /** How many daily copies (`orrery-YYYY-MM-DD.db`) stay in the backup folder. */
    backup_keep?: number
}

/** A database the owner could move to, as `POST /api/database/check` finds it. */
export interface DatabaseCheck {
    kind: 'sqlite' | 'postgres'
    /** Where it is, as App settings shows it (no password). */
    where: string
    /** `empty`: nothing in it yet, so everything can be copied in; `orrery`: an orrery's own, to run on as it is;
     * `current`: the one orrery runs on now; `other`: something else's tables, which orrery leaves alone. */
    state: 'empty' | 'orrery' | 'current' | 'other'
    /** An orrery's projects, when it is one. */
    projects?: number
}

export interface Settings {
    /** This orrery's id, made once when it first starts (`orr_7f3a9c`): a channel set up for it checks it's
     * talking to the same orrery (ORRERY_ID), whatever its address. */
    id: string
    /** Which orrery this is (`personal`, `work`), as it's run; a channel serving it is named `orrery-<environment>`. */
    environment?: string
    /** Where its data is (`GET /api/settings` only). */
    database?: DatabaseInfo
    /** The colour the page's background takes on, so one orrery looks unlike another; none by default. */
    tint: string | null
    /** The issue statuses, in board order. */
    statuses: IssueStatus[]
    /** What a session hears when asked to focus on an issue, or to work through a chunk; none is the default
     * (`DEFAULT_FOCUS_PROMPT`, `DEFAULT_CHUNK_PROMPT`). A project can have its own. */
    focus_prompt: string | null
    chunk_prompt: string | null
    /** Lines added to every focus, such as `commit whenever a piece works`. */
    instructions: Instruction[]
    /** The owner's handle in an issue's reference (`orrery-<handle>: DOC-132`), such as their GitHub login;
     * none uses their id. */
    handle: string | null
    /** Where the team's tracker shows a task, with `{id}` for its id: `https://tracker.example.com/issue/{id}`. */
    tracker: string | null
    /** Whether orrery starts sessions itself, for any project whose repo has a launcher, and within what; none
     * while the owner hasn't let it. */
    starts: Starts | null
    /** The terminal app Watch opens a session orrery started in, on its launcher's machine. */
    terminal: TerminalApp
    /** Whether a proposal waiting on the owner (pending, or changes asked for) is theirs alone until they decide:
     * an agent can't start it, change its status, assign it or put it in a release. On unless the owner turns it off. */
    restrict_proposals: boolean
    /** Shows what's for looking into problems: the Events page, and a notice in the bell for each new kind of error.
     * Off by default; errors are recorded either way, what orrery did only while it's on. */
    advanced: boolean
    /** A listening session out of work is handed the issues it may start, Todo then Backlog, to pick one (ORR-452). */
    pick_next: boolean
}
