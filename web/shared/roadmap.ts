// A project's roadmap as the board draws it: the server reads it from the database, places every
// issue in a column and rolls the columns up into parents and chunks, so the page only draws.
import type {OnFilter} from './happenings'
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
export type Proposal = 'pending' | 'approved' | 'changes' | 'rejected'
/** What the owner can decide on a proposal. */
export const DECISIONS = ['approved', 'changes', 'rejected'] as const
export type Decision = (typeof DECISIONS)[number]

/** One option of a choice: `A`, `B`, … or a word, with a title and (Markdown) more about it. */
interface ChoiceOption {
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

/** The choices that count for these picks: those at the top, and those going further down a picked option. */
export function liveChoices(choices: Choice[], picks: Picks): Choice[] {
    const live: Choice[] = []
    for (const choice of choices) {
        const from = choice.from
        if (!from || (live.some(c => c.key === from.choice) && (picks[from.choice] ?? []).includes(from.option))) live.push(choice)
    }
    return live
}

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
    /** Its tasks on the team's tracker: ids (`CIR-1567`), linked through the Orrery's `tracker`, or full URLs. */
    external: string[]
    /** A status's id, as written; a parent's own status is ignored, its issues decide its column. */
    status: string
    notes?: string
    /** Set when it's a proposal (with its sub-issues): not work until the owner commits it. */
    proposal?: Proposal
    /** Who last decided on the proposal, when, and what they said. */
    decided_by?: string
    decided_at?: string
    decision_note?: string
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
    /** An agent's question on it the owner hasn't answered yet (no comment of theirs after it): what it waits for. */
    waiting?: Asks
    /** Ids it had before (e.g. `MOT-5`), which still find it. */
    aliases: string[]
    /** The schedule that made it, if one did. */
    schedule?: number
    /** The version it ships in (a release's), if it's set for one. */
    release?: string
    created_by: string
    /** Made by the owner: no one else can delete it. */
    protected: boolean
    created_at: string
    updated_at: string
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
    created_by: string
    protected: boolean
    tasks: Issue[]
}

export interface Board {
    chunks: Chunk[]
    counts: Counts
    kinds: Kinds
}

/** A version the project ships (`1.0.0-rc.2`) and how far the issues going out in it are. */
export interface Release {
    version: string
    /** The branch its work gathers on before it ships, e.g. `v1.0.0-rc.2`. */
    branch?: string
    /** What it's about, in Markdown. */
    notes?: string
    /** The day its features froze (`YYYY-MM-DD`): from then on it takes fixes, tests and docs, by preference. */
    frozen_on?: string
    /** The day it shipped (`YYYY-MM-DD`); none while it's being prepared. */
    shipped_on?: string
    /** Its issues: those set for it, each with its sub-issues (in every project drawing on it, on its source). */
    issues: number
    kinds: Kinds
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
}

/** Whether the release is in feature freeze: frozen, and not shipped yet. */
export const isFrozen = (release: Pick<Release, 'frozen_on' | 'shipped_on'> | undefined) => !!release?.frozen_on && !release.shipped_on

/** What a session hears about an issue set for a release in feature freeze: a preference, never a refusal. */
export function freezeNote(release: Pick<Release, 'version' | 'frozen_on' | 'shipped_on'> | undefined): string | null {
    if (!release || !isFrozen(release)) return null
    return `${release.version} is in feature freeze (since ${release.frozen_on}): it takes fixes, tests and docs. Put a new feature on the next release instead, so this one can go out.`
}

/** A doc without its text, as a project lists it. */
export interface DocSummary {
    id: string
    title: string
    /** Its first paragraph as plain text, cut to about 160 characters: enough to tell whether to open it. */
    summary: string
    /** With a search (`?q=`): the text around its first hit, empty when only the title has it. */
    match?: string
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
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
    /** The prefix of the issue ids the server hands out, e.g. `GRE` for `GRE-12`. */
    key: string
    description?: string
    /** Its icon in the sidebar: a Heroicon's name, e.g. `shopping-cart`. */
    icon?: string
    /** Its icon's colour: a tint's name (`teal`) or a `#rrggbb`; none follows the text. */
    icon_color?: string
    /** What its sessions hear when asked to focus on an issue or a chunk, when not the Orrery's (`Settings`). */
    focus_prompt?: string
    chunk_prompt?: string
    /** Its own standing instructions, and the ids of the Orrery's it switches off. */
    instructions: Instruction[]
    muted: string[]
    /** Whether Orrery may start sessions for it itself, when the owner's signal finds nobody listening, and
     * within what: the Orrery's setting (`Settings.starts`), the same for every project; none while the owner hasn't let it. */
    starts?: Starts
    /** Where its code is (`https://github.com/you/shop`), to link a release's branch and PRs. */
    repo?: string
    /** Whether it has releases: `none` (not everything ships), its `own`, or `shared`, another project's. */
    release_mode: ReleaseMode
    /** The project whose releases it ships in, when it's `shared` (a monorepo's apps going out together); its
     * `releases` are then that project's, counting its own issues. */
    releases_from?: string
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
    board: Board
    docs: DocSummary[]
    /** In the order they're arranged in, a new one on top. */
    releases: Release[]
}

/** What an agent's comment waits on the owner for. */
export const ASKS = ['decision', 'feedback'] as const
export type Asks = (typeof ASKS)[number]

/** An image kept for Markdown to show (`POST /api/uploads`). */
export interface Upload {
    id: string
    type: string
    size: number
    /** Where it's served: /api/uploads/<id>. */
    url: string
    /** `![name](url)`, to put in a comment. */
    markdown: string
}

export interface Comment {
    id: number
    issue: string
    body: string
    /** It waits on the owner for this, until they comment on the issue after it (`answered`). */
    asks?: Asks
    answered?: boolean
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
}

/** What an issue's activity records: a field that changed, `created` when it was made, `project` when it
 * moved in from another project. */
/** Whether a project has releases: none, its own, or another project's (`releases_from`). */
export const RELEASE_MODES = ['none', 'own', 'shared'] as const
export type ReleaseMode = typeof RELEASE_MODES[number]

export type ActivityField = 'created' | 'title' | 'status' | 'priority' | 'assignee' | 'labels' | 'external' | 'notes' | 'chunk' | 'parent' | 'proposal' | 'project' | 'release'

/** One change to an issue: who set `field` from `before` to `after`, and when. Values are as stored (a
 * status's id, a chunk's id, labels as a JSON list); none means unset. Notes keep no values. */
export interface IssueEvent {
    id: number
    issue: string
    field: ActivityField
    before?: string
    after?: string
    created_by: string
    protected: boolean
    created_at: string
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
    /** The issue it's about, or for a focus on a whole chunk, `chunk` (`none`: the issues in no chunk; `all`: every chunk's). */
    issue?: string
    chunk?: string
    /** For a chunk: only its issues of these statuses (ids or kinds, comma-separated), not all its open ones. */
    status?: string
    /** For a chunk: only its issues set for this release. */
    release?: string
    /** The schedule that sent it (a message). */
    schedule?: number
    kind: 'focus' | 'comment' | 'message'
    note?: string
    /** A message the owner sent from a preset: its name, as it was then. */
    preset?: string
    /** A message the owner's chat sent for them, on their say-so. */
    via?: 'chat'
    /** The session it's for; none means every session on the project. */
    target?: string
    /** The names of the sessions it reached. */
    delivered_to: string[]
    /** The standing instructions picked for a focus, as said. */
    instructions: string[]
    created_by: string
    /** Sent by the owner. Sessions only act on these. */
    protected: boolean
    created_at: string
}

/** One time a schedule ran: the issue it made, or why it didn't. */
export interface ScheduleRun {
    at: string
    /** `made` an issue, `sent` a message, or `skipped` / `failed` (with why). */
    outcome: 'made' | 'sent' | 'skipped' | 'failed'
    issue?: string
    note?: string
    /** What an event run was about (an issue's id, a release's version), once per schedule. */
    subject?: string
}

/** Recurring work in a project: at each time (`cron` in `timezone`, once `at`, or `on` an event) Orrery makes an issue
 * from it, and with `ask` points the project's listening Claude sessions at it; or, as a `message`
 * schedule, sends `notes` to the sessions without an issue; or, as a `session` schedule, starts a session. */
export interface Schedule {
    id: number
    project: string
    kind: 'issue' | 'message' | 'session'
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
    /** Where its issues start: a status's id (not a closed one). */
    column: string
    chunk?: string
    priority?: Priority
    labels: string[]
    ask: boolean
    /** Skips a run while the issue from the last one isn't done. */
    skip_open: boolean
    /** A message schedule: skips a run when no issue or comment in the project changed since the last one it sent. */
    only_if_changed: boolean
    /** A message schedule whose session reads what others wrote (GitHub issues): its message goes to a session
     * started for it alone, with only `gh issue list/view` and the Orrery tools, and what that session raises is a proposal. */
    untrusted: boolean
    enabled: boolean
    /** When it runs next; none once it's paused or a one-off has run. */
    next_run?: string
    /** The latest runs, newest first. */
    runs: ScheduleRun[]
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
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

/** The sessions Orrery may start, the owner's one setting for every project: at most `limit` running at once on each, each running until it's stopped,
 * or for `minutes` when set. `idle_minutes` stops one that has sat idle with nothing to do for that long. Neither
 * stops a session mid-work: it waits until the session is idle with nothing in progress or waiting. */
export interface Starts {
    limit: number
    minutes?: number
    idle_minutes?: number
}

/** The terminal apps Watch can open (on macOS; elsewhere the system's own terminal opens), by their setting. */
export const TERMINALS = {terminal: 'Terminal', iterm: 'iTerm2', warp: 'Warp', ghostty: 'Ghostty'} as const
export type TerminalApp = keyof typeof TERMINALS

/** Where this Orrery keeps its data, as App settings shows it (read only): a SQLite file's path, or a Postgres
 * database as `user@host:port/name`, never its password; the folder it's backed up to, if any, and when the
 * latest backup there was made. */
export interface DatabaseInfo {
    kind: 'sqlite' | 'postgres'
    where: string
    /** Under Docker, where the SQLite file is on the computer (from `ORRERY_DATA`), or the Docker volume it's in
     * instead; `where` stays the path Orrery opens, inside the container. */
    host?: string
    volume?: string
    backup?: string
    /** The same for the backup folder (from `ORRERY_BACKUP`). */
    backup_host?: string
    backup_volume?: string
    backed_up_at?: string
    /** How big it is, in bytes: a SQLite file with its `-wal`, or the Postgres database; none when it can't be read. */
    size?: number
    /** The backup folder's files together, in bytes. */
    backup_size?: number
    /** Whether the owner can move it from App settings: not when NUXT_DATABASE (ORRERY_DATABASE) is Postgres. */
    movable?: boolean
    /** Whether it was moved there from App settings, rather than set as Orrery starts. */
    moved?: boolean
}

/** A database the owner could move to, as `POST /api/database/check` finds it. */
export interface DatabaseCheck {
    kind: 'sqlite' | 'postgres'
    /** Where it is, as App settings shows it (no password). */
    where: string
    /** `empty`: nothing in it yet, so everything can be copied in; `orrery`: an Orrery's own, to run on as it is;
     * `current`: the one Orrery runs on now; `other`: something else's tables, which Orrery leaves alone. */
    state: 'empty' | 'orrery' | 'current' | 'other'
    /** An Orrery's projects, when it is one. */
    projects?: number
}

export interface Settings {
    /** This Orrery's id, made once when it first starts (`orr_7f3a9c`): a channel set up for it checks it's
     * talking to the same Orrery (ORRERY_ID), whatever its address. */
    id: string
    /** Which Orrery this is (`personal`, `work`), as it's run; a channel serving it is named `orrery-<environment>`. */
    environment?: string
    /** Where its data is (`GET /api/settings` only). */
    database?: DatabaseInfo
    /** The colour the page's background takes on, so one Orrery looks unlike another; none by default. */
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
    /** Whether Orrery starts sessions itself, for any project whose repo has a launcher, and within what; none
     * while the owner hasn't let it. */
    starts: Starts | null
    /** The terminal app Watch opens a session Orrery started in, on its launcher's machine. */
    terminal: TerminalApp
    /** Whether a proposal waiting on the owner (pending, or changes asked for) is theirs alone until they decide:
     * an agent can't start it, change its status, assign it or put it in a release. On unless the owner turns it off. */
    restrict_proposals: boolean
    /** Shows what's for looking into problems: the Events page, and a notice in the bell for each new kind of error.
     * Off by default; errors are recorded either way, what Orrery did only while it's on. */
    advanced: boolean
}

/** How much an event matters: something went wrong, something looks off, or what Orrery did. */
export const EVENT_LEVELS = ['error', 'warn', 'info'] as const
export type EventLevel = (typeof EVENT_LEVELS)[number]

/** The kinds that are changes to the roadmap (ORR-378), as the store says them: `issue.<field>`, `comment.added`,
 * `release.frozen`…, kept apart in the event log's cap. */
export const ACTIVITY_FAMILIES = ['issue', 'comment', 'chunk', 'doc', 'release'] as const

/** A line in the event log (`GET /api/events/log`): what Orrery did, what went wrong or a change to the roadmap, its
 * `kind` a dotted name (`server.error`, `session.started`, `backup.made`, `issue.status`…). Each is a line of its own
 * (ORR-378): `count` is 1, and `last_seen` is `first_seen`, on those recorded since. */
export interface LoggedEvent {
    id: number
    level: EventLevel
    kind: string
    project?: string
    /** What it's about, for a change to the roadmap: the issue's id, the release's version, the chunk's or doc's id. */
    subject?: string
    message: string
    /** What else there is to know (a route, a stack, a version), never a request's body or headers or a secret's value. */
    details?: Record<string, unknown>
    count: number
    first_seen: string
    last_seen: string
    /** When someone said it's dealt with; the next one starts a row of its own. */
    resolved_at?: string
}

/** Where a team task opens: a full URL as it is, an id through the tracker's pattern; none without one. */
export function taskUrl(tracker: string | null, task: string): string | undefined {
    if (/^https?:\/\//.test(task)) return task
    return tracker ? tracker.replace('{id}', encodeURIComponent(task)) : undefined
}

/** An issue's reference, saying whose board it's on, for commit bodies and PR descriptions: `orrery-steffendybvik: DOC-132`. */
export const issueRef = (handle: string, id: string) => `orrery-${handle.toLowerCase()}: ${id}`

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
    started_at: string
    /** Its channel is connected, so a signal reaches it. */
    listening: boolean
    /** The other projects its channel is heard on, when it serves several (ORRERY_PROJECTS). */
    also?: string[]
    /** The name its channel's server goes by in the repo's .mcp.json, as the channel found it: what restarts it with the channel. */
    server?: string
    /** Its channel is open (even without the channel flag) and ends it when asked, so the owner can stop it from Orrery. */
    reachable?: boolean
    /** Orrery started it (no terminal): which launch, the tmux session it runs in, and when it's stopped. */
    started?: StartedSession
}

/** What a session is on, for its project's Sessions page: the open issues it worked last, newest first, and
 * the last signals that went to it. */
export interface SessionWork {
    issues: Pick<Issue, 'id' | 'title' | 'column' | 'kind' | 'priority'>[]
    signals: Signal[]
}

/** The owner's chat with a session started for it (chats.ts): its id is its launch's. `ended` on the last word of one
 * that's gone. */
export interface Chat {
    id: string
    project: string
    started_at: string
    messages: ChatMessage[]
    ended?: boolean
    /** Why its session can't start, while that holds: a launcher too old to start a chat refused it (ORR-383). */
    problem?: string
}

/** A message in a chat: the owner's (with the ids of the uploads they pasted) or the session's answer, in Markdown. */
export interface ChatMessage {
    id: number
    from: 'owner' | 'claude'
    text: string
    images: string[]
    at: string
    /** The session asking to change an App setting, which waits on the owner's Allow. */
    request?: ChatRequest
}

/** The App settings the owner's chat may ask to change (ORR-405), by what App settings calls them. The rest (secrets,
 * the database, statuses, prompts, how sessions start) stay the owner's to change there. */
export const CHAT_SETTINGS = {
    tracker: 'Team tracker',
    tint: 'Background tint',
    restrict_proposals: 'Keep agents off proposals',
    handle: 'Your handle',
    advanced: 'Advanced',
} as const
export type ChatSetting = keyof typeof CHAT_SETTINGS

/** One setting the chat asked to change, from what to what: saved only once the owner allows it, and `expired` when
 * they didn't answer in time or it asked again. */
export interface ChatRequest {
    setting: ChatSetting
    from: unknown
    to: unknown
    state: 'asked' | 'allowed' | 'denied' | 'expired'
}

/** A setting's value as a chat's request shows it. */
export const settingValue = (value: unknown) => value === null || value === undefined || value === '' ? '(none)' : value === true ? 'on' : value === false ? 'off' : String(value)

/** A session Orrery started, as its launch made it. */
export interface StartedSession {
    launch: string
    tmux: string
    /** When its time is up, if the project gives sessions a time; none runs until stopped. */
    stops_at?: string
    /** What the owner gave it to go on when they started it, if anything. */
    context?: SessionContext
    /** Started for an untrusted schedule's run: it reads what others wrote, so it hears only that run's message,
     * has only `gh issue list/view` and the Orrery tools, and what it raises is a proposal. */
    untrusted?: boolean
    /** Started for the owner's chat: it hears only the chat's messages, reads and answers, and makes issues and
     * comments when asked; nothing else. */
    chat?: boolean
}

/** More context for a session, from the owner as they start it: the presets they picked (by name) and their own
 * words (`instructions`), joined in `text`. It goes with every signal to the session, and back to it after a `/clear`. */
export interface SessionContext {
    presets: string[]
    instructions?: string
    text: string
}

/** A saved piece of context the owner can give a session as they start it: the Orrery's (`project` null), for
 * sessions on any project, or a project's own. */
export interface Preset {
    id: number
    project: string | null
    name: string
    text: string
    /** Its badge: a Heroicon's name (`shield-check`) in a colour (a tint's name or `#rrggbb`); without an icon,
     * its initials. */
    icon: string | null
    color: string | null
    /** One Orrery ships: its key (shared/presets.ts), and whether it's been changed since, so it can be reset. */
    default?: {key: string, changed: boolean}
    created_at: string
    updated_at: string
}

/** An agent's comment, as the notification bell and page list it. */
export interface Notice extends Comment {
    project: string
    title: string
    /** Taken out of the bell; only `GET /notices?list=cleared` lists these. */
    cleared?: boolean
    /** An agent's proposal waiting on the owner instead of a comment: `asks: decision` until they decide it,
     * its notes as the body, put up at `created_at`, `id` 0. Clearing doesn't take it out. */
    proposal?: {choices: number}
}

/** Tells notices apart: a comment by its id, a proposal by its issue. */
export const noticeKey = (n: Notice) => n.proposal ? `${n.project}/${n.issue}` : String(n.id)

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
    created_by: string
    created_at: string
    updated_at: string
    last_used: SecretUse | null
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
    created_by: string
    created_at: string
}

/** A name as an id: lowercase letters, digits and dashes, at most 40 (a project's, a doc's). */
export function slugify(text: string): string {
    return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
}

/** Three capitals from the name, e.g. `GRE` for Greenhouse. */
export function keyFor(name: string): string {
    const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '')
    return letters.slice(0, 3) || 'ISS'
}

/** The names Orrery gives sessions that have none of their own, in the order it hands them out, written as in
 * Norwegian: æsene, vanene, jotnene, a light elf, and dverger (Snorri's svartalver are the same folk). */
export const SESSION_NAMES = [
    'Odin', 'Tor', 'Frigg', 'Balder', 'Ty', 'Heimdall', 'Loke', 'Brage', 'Idun', 'Vidar', 'Vale', 'Forsete', 'Ull', 'Hod', 'Hermod',
    'Siv', 'Saga', 'Eir', 'Høne', 'Mime', 'Magne', 'Mode', 'Nanna', 'Fulla', 'Gna', 'Lovn', 'Snotra', 'Sjøvn', 'Var',
    'Njord', 'Frøy', 'Frøya', 'Kvase', 'Gullveig',
    'Ymer', 'Skade', 'Gerd', 'Tjatse', 'Trym', 'Surt', 'Hyme', 'Gyme', 'Æge', 'Ran', 'Angerboda', 'Suttung', 'Bauge', 'Gunnlød',
    'Vavtrudne', 'Rungne', 'Geirrød', 'Hyrrokkin', 'Bergelme', 'Utgardsloke',
    'Volund',
    'Durin', 'Motsogne', 'Dvalin', 'Brokk', 'Sindre', 'Andvare', 'Alvis', 'Regin', 'Fjalar', 'Galar', 'Nordre', 'Sudre', 'Austre',
    'Vestre', 'Alfrik', 'Lit', 'Ny', 'Nide', 'Fili', 'Kili', 'Oin', 'Torin', 'Bombur', 'Gandalv',
] as const

const BARE_NAME = new RegExp(`^(${SESSION_NAMES.join('|')})( [IVXLCDM]+)?$`)

/** Whether Orrery made the session's name up, rather than the session or its hooks giving it: `<project> · <name>` for
 * one that hears its own project, the bare name (`Odin`) for one that hears several. */
export const madeUpName = (session: {name: string, project: string}) => session.name.startsWith(`${session.project} · `) || BARE_NAME.test(session.name)

/** Its name where its project already shows beside it: `Odin` for `orrery · Odin`; any other name as it is. */
export const nameBesideProject = (session: {name: string, project: string}) =>
    session.name.startsWith(`${session.project} · `) ? session.name.slice(session.project.length + 3) || session.name : session.name
