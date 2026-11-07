// Claude sessions: the signals they hear, what they're doing and on, the ones orrery started, the context and
// presets they're started with, and the names orrery gives them.
import type {Issue} from './board'

/** A word to the Claude sessions on a project: `focus` asks one to work on the issue (or work through
 * the milestone) now; `comment` brings the owner's comment on an issue (in `note`) to the session working
 * on it, to answer; `message` is a schedule's message (in `note`), about no issue. */
export interface Signal {
    /** A member's signal (ORR-658): only their sessions hear it. The owner's say `protected` instead. */
    person?: string
    /** The model its work needs, pooled (ORR-868): its issue's, or a milestone's heaviest. No session started on a lighter one
     * takes it; none, any session can. */
    model?: string
    id: number
    project: string
    /** The issue it's about, or for a focus on a whole milestone, `milestone` (`none`: the issues in no milestone; `all`: every milestone's). */
    issue?: string
    milestone?: string
    /** For a milestone: only its issues of these statuses (ids or kinds, comma-separated), not all its open ones. */
    status?: string
    /** For a milestone: only its issues set for this release. */
    release?: string
    /** For a milestone (`all`, from a focus on an epic, ORR-987): only its issues in this epic. */
    epic?: number
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
    /** The model it runs on, as Claude Code names it (`claude-opus-5-5`), from its hook: the latest reply's model in its
     * transcript, so a `/model` switch shows after its next turn (ORR-871). None until it has said. */
    model?: string
    /** The effort level it runs at, from its hook on tool events, so an `/effort` switch shows too (ORR-894). None until it
     * has said: then the one it was started at (`started.effort`), if any. */
    effort?: Effort
    /** How much context it carries (ORR-968), from its hook after a turn and on tool events: the tokens its latest reply
     * was given, the model's `window`, and `compacted` once Claude Code has compacted it (which lowers the count)
     * since its last clear. None until it has said. */
    context?: ContextUse
    /** It started an issue out of the scope of the one it worked before, with more than `CARRY_FROM` tokens in its context
     * (ORR-968): it pays for the old issue's context on every turn of the new one. Until a clear. */
    carried_over?: CarriedOver
}

/** An issue a session started without clearing what it worked before (ORR-968): the issue before, the one now, and the
 * tokens it carried in. */
export interface CarriedOver {from: string, to: string, tokens: number, at: string}

/** The context a session may carry into an issue out of scope before it's marked (ORR-968): about what a fresh session
 * holds once its tools and the brief are in, with room for a short look round. */
export const CARRY_FROM = 50_000

/** What says whether two issues are one piece of work (ORR-968). */
export interface IssueScope {project: string, id: string, parent?: string | null, milestone?: string | null, epic?: number | null}

/** Whether a session's next issue is the same work as its last (ORR-968): the same issue, one's sub-issue or a sibling,
 * or in the same epic or milestone. Such a one keeps its context; any other is better started afresh. */
export function sameScope(a: IssueScope, b: IssueScope): boolean {
    if (a.epic && a.epic === b.epic) return true
    if (a.project !== b.project) return false
    return a.id === b.id || b.parent === a.id || a.parent === b.id || (!!a.parent && a.parent === b.parent) || (!!a.milestone && a.milestone === b.milestone)
}

/** How much context a session carries, as its hook last said (ORR-968). */
export interface ContextUse {tokens: number, window: number, compacted?: boolean}

/** How full a session's context is, from 0 to 1. */
export const contextShare = ({tokens, window}: ContextUse) => Math.min(1, Math.max(0, tokens / window))

/** Whether a session goes in a list of sessions (ORR-716): something can be done with it there, as it hears signals, its
 * channel can stop it, or orrery started it. Any other is known only from its hooks, and has no message box and no Stop. */
export const listable = (session: Pick<Session, 'listening' | 'reachable' | 'started'>) => session.listening || !!session.reachable || !!session.started

/** Whether Close all on the Sessions page stops a session (ORR-970): one a Stop reaches, orrery's through its launch or a
 * terminal's through its channel, except the owner's chat, which is their conversation rather than work. */
export const closable = (session: Pick<Session, 'reachable' | 'started'>) => (!!session.started || !!session.reachable) && !session.started?.chat

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
    /** The model and effort it was started on (`claude --model … --effort …`), when it asked for any; none, on
     * Claude Code's default there (ORR-868). */
    model?: string
    effort?: Effort
}

/** The effort levels Claude Code takes at start (`--effort`). */
/** What a session runs on, as ModelChip shows it: a session, or what an ended chat kept of its own (ORR-936). */
export type RunsOn = Pick<Session, 'model' | 'effort'> & {started?: Pick<StartedSession, 'model' | 'effort'>}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = typeof EFFORTS[number]
/** The models a session can be started on: an alias Claude Code takes (`best`, `opus`, `sonnet`, `haiku`, `fable`,
 * `default`, `opusplan`), which follows its family's newest model, or a full id (`claude-sonnet-5-5`), which never moves. */
export const MODEL_ALIASES = ['best', 'opus', 'sonnet', 'haiku', 'fable', 'default', 'opusplan'] as const
export const isModel = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= 64 && ((MODEL_ALIASES as readonly string[]).includes(value) || /^claude-[a-z0-9.-]+(\[1m\])?$/.test(value))
export const isEffort = (value: unknown): value is Effort => (EFFORTS as readonly unknown[]).includes(value)

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

/** A model's id as people say it (ORR-871): `claude-opus-5-5` is Opus 5.5, `claude-sonnet-5-20260101` Sonnet 5, and a
 * 1M context (`[1m]`) says so. An id it can't read is shown as it is. */
export function modelLabel(id: string): string {
    const long = /\[1m\]$/i.test(id)
    const match = /^(?:anthropic\.)?claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:\[1m\])?$/i.exec(id.trim())
    if (!match) return id
    const [, family, major, minor] = match as unknown as [string, string, string, string | undefined]
    const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}`
    return long ? `${name} · 1M` : name
}
