// Claude sessions: the signals they hear, what they're doing and on, the ones orrery started, the context and
// presets they're started with, and the names orrery gives them.
import type {Issue} from './board'

/** A word to the Claude sessions on a project: `focus` asks one to work on the issue (or work through
 * the chunk) now; `comment` brings the owner's comment on an issue (in `note`) to the session working
 * on it, to answer; `message` is a schedule's message (in `note`), about no issue. */
export interface Signal {
    /** A member's signal (ORR-658): only their sessions hear it. The owner's say `protected` instead. */
    person?: string
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

/** What a Claude session is doing, as its hooks last said: `waiting` is waiting on the owner. */
export const SESSION_STATES = ['starting', 'working', 'idle', 'waiting'] as const
export type SessionState = (typeof SESSION_STATES)[number]

/** A Claude window working on a project, known from its hooks and its channel. */
export interface Session {
    /** Whose it is, as its stream said when it connected (ORR-658). */
    person?: string
    /** Claude Code's session id. */
    id: string
    project: string
    /** `ORRERY_SESSION` when it was started, else "<project> <n>". */
    name: string
    cwd?: string
    state: SessionState
    /** When it got into that state. */
    since: string
    /** While it's `waiting`: what it's asking permission for, as Claude Code's notification says it. */
    asks?: string
    /** While it's `waiting`: the tool it asks to use, and what it would do with it (the command, file, address or
     * search, cut short), as its hook said. */
    asking?: SessionTool
    started_at: string
    /** Its channel is connected, so a signal reaches it. */
    listening: boolean
    /** The other projects its channel is heard on, when it serves several (ORRERY_PROJECTS). */
    also?: string[]
    /** The name its channel's server goes by in the repo's .mcp.json, as the channel found it: what restarts it with the channel. */
    server?: string
    /** Its channel is open (even without the channel flag) and ends it when asked, so the owner can stop it from orrery. */
    reachable?: boolean
    /** orrery started it (no terminal): which launch, the tmux session it runs in, and when it's stopped. */
    started?: StartedSession
    /** The version of the code its channel runs, as it says (one from before 1.0.0-rc.10 doesn't). */
    version?: string
    /** Its last turn was cut off by an API error (Claude Code's StopFailure), until its next turn gets going (ORR-646):
     * the `error` it named (`rate_limit`…), and what Claude Code told it, cut short. */
    cut_off?: {error?: string, text?: string, at: string}
}

/** Whether a session goes in a list of sessions (ORR-716): something can be done with it there, as it hears signals, its
 * channel can stop it, or orrery started it. Any other is known only from its hooks, and has no message box and no Stop. */
export const listable = (session: Pick<Session, 'listening' | 'reachable' | 'started'>) => session.listening || !!session.reachable || !!session.started

/** The sessions the one-line hint is about (ORR-716): started by hand without the channel, so they can't hear the owner. */
export const withoutChannel = <T extends Pick<Session, 'listening' | 'started'>>(sessions: T[]) => sessions.filter(s => !s.listening && !s.started)

/** What a session's cut-off says on the page, in a few words (ORR-646). */
export const cutOffLabel = ({error}: {error?: string}) => ({rate_limit: 'usage limit reached', billing_error: 'billing error'} as Record<string, string>)[error ?? ''] ?? 'cut off by an API error'

/** A tool a session uses, as its hook says it: Claude Code's name for it (`Bash`, `Edit`, `mcp__orrery__comment`…),
 * and for some what it would do. */
export interface SessionTool {
    name: string
    detail?: string
}

/** What a session is on, for its project's Sessions page: the open issues it worked last, newest first, each with
 * when it took it (`since`, none on one from before 1.0.0-rc.11), and the last signals that went to it. */
export interface SessionWork {
    issues: (Pick<Issue, 'id' | 'title' | 'column' | 'kind' | 'priority'> & {since?: string})[]
    signals: Signal[]
}

/** A session orrery started, as its launch made it. */
export interface StartedSession {
    launch: string
    tmux: string
    /** When its time is up, if the project gives sessions a time; none runs until stopped. */
    stops_at?: string
    /** What the owner gave it to go on when they started it, if anything. */
    context?: SessionContext
    /** The projects it hears, its own first, when it was started to hear more than its repo's channel says. */
    hears?: string[]
    /** Started for an untrusted schedule's run: it reads what others wrote, so it hears only that run's message,
     * has only the orrery tools (`github_issues` among them), and what it raises is a proposal. */
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

/** A saved piece of context the owner can give a session as they start it: the orrery's (`project` null), for
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
    /** One orrery ships: its key (shared/presets.ts), and whether it's been changed since, so it can be reset. */
    default?: {key: string, changed: boolean}
    created_at: string
    updated_at: string
}

/** The names orrery gives sessions that have none of their own, in the order it hands them out, written as in
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

/** Whether orrery made the session's name up, rather than the session or its hooks giving it: `<project> · <name>` for
 * one that hears its own project, the bare name (`Odin`) for one that hears several. */
export const madeUpName = (session: {name: string, project: string}) => session.name.startsWith(`${session.project} · `) || BARE_NAME.test(session.name)

/** Its name where its project already shows beside it: `Odin` for `orrery · Odin`; any other name as it is. */
export const nameBesideProject = (session: {name: string, project: string}) =>
    session.name.startsWith(`${session.project} · `) ? session.name.slice(session.project.length + 3) || session.name : session.name
