// Schedules: recurring work in a project, and each time one ran.
import type {OnFilter} from '../happenings'
import type {Priority} from './board'

/** One time a schedule ran: the issue it made, or why it didn't. */
export interface ScheduleRun {
    at: string
    /** `made` an issue (or an action schedule's move), `sent` a message, or `skipped` / `failed` (with why). */
    outcome: 'made' | 'sent' | 'skipped' | 'failed'
    issue?: string
    note?: string
    /** What an event run was about (an issue's id, a release's version), once per schedule. */
    subject?: string
}

/** Recurring work in a project: at each time (`cron` in `timezone`, once `at`, or `on` an event) orrery makes an issue
 * from it, and with `ask` points the project's listening Claude sessions at it; or, as a `message`
 * schedule, sends `notes` to the sessions without an issue; or, as a `session` schedule, starts a session. */
export interface Schedule {
    id: number
    project: string
    kind: 'issue' | 'message' | 'session' | 'action'
    title: string
    /** The issue's description, or the message. */
    notes?: string
    cron?: string
    at?: string
    /** Runs when an event of this type happens instead of on a clock: `issue.status`, `release.*` (shared/happenings.ts). */
    on?: string
    /** What the event must also say: `{to: "in-review"}`, `{by: "owner"}`, `{level: "error"}`. */
    on_filter?: OnFilter
    /** Preset ids a message or session schedule is given, their text before `notes`; none for an issue schedule. */
    presets: number[]
    timezone: string
    /** Where its issues start: a status's id (not a closed one). An action schedule's: the status it moves them to. */
    column: string
    /** The statuses (ids or kinds) an action schedule moves issues out of; none, any open one. */
    move_from: string[]
    chunk?: string
    priority?: Priority
    labels: string[]
    ask: boolean
    /** Skips a run while the issue from the last one isn't done. */
    skip_open: boolean
    /** A message schedule: skips a run when no issue or comment in the project changed since the last one it sent. */
    only_if_changed: boolean
    /** A message schedule whose session reads what others wrote (GitHub issues): its message goes to a session
     * started for it alone, with only the orrery tools (`github_issues` among them), and what that session raises is a proposal. */
    untrusted: boolean
    enabled: boolean
    /** When it runs next; none once it's paused or a one-off has run. */
    next_run?: string
    /** The schedule across projects it's made from (ORR-638), which says what it does; it can only be paused here. */
    across?: number
    /** The latest runs, newest first. */
    runs: ScheduleRun[]
    /** How many subjects its minute held back, waiting their turn at one a minute (ORR-357); none when none are. */
    held?: number
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
}

/** A schedule across projects (ORR-638): what it says, as a schedule's fields, and the projects it's for. Each has an
 * ordinary schedule made from it (`across`), with its own runs and guards. */
export interface ScheduleAcross extends Partial<Omit<Schedule, 'id' | 'project' | 'across' | 'runs' | 'next_run' | 'held'>> {
    id: number
    title: string
    /** Every project (`*`), those added later too; or a list. */
    projects: '*' | string[]
    /** The projects that opted out of `*`. */
    skip: string[]
    /** The projects it has a schedule on now. */
    on_projects: string[]
    created_by: string
    created_at: string
    updated_at: string
}
