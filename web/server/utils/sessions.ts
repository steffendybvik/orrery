// The Claude sessions working on each project, kept in memory (they're live, not history). A
// session's hooks say who it is and what it's doing (POST /api/sessions); its channel, while
// connected, says it's there to hear signals. Both name the window by Claude Code's session id,
// falling back to the claude process's pid.
import type {Session, SessionState} from '#shared/roadmap'

interface Known extends Session {
    pid?: number
    /** When a hook last spoke. */
    seenAt: number
}

const sessions = new Map<string, Known>()
// A session nothing has heard from in this long, and that isn't listening, is dropped.
const FORGET_AFTER = 6 * 60 * 60 * 1000

/** What each hook event means for the session's state; `end` drops it. */
const STATES: Record<string, SessionState | 'end'> = {
    SessionStart: 'idle',
    UserPromptSubmit: 'working',
    PreToolUse: 'working',
    Stop: 'idle',
    SessionEnd: 'end',
}

export interface Report {
    id?: string
    pid?: number
    project: string
    name?: string
    cwd?: string
    /** A hook event name, or a state. */
    event: string
    /** For `Notification`: what Claude Code is waiting for. */
    message?: string
    /** For `PreToolUse` on Bash: the command it's about to run, to see which issues it writes to. */
    command?: string
}

function find(id?: string, pid?: number): Known | undefined {
    if (id && sessions.has(id)) return sessions.get(id)
    if (pid) return [...sessions.values()].find(s => s.pid === pid)
    return undefined
}

/** "<project> <n>", the lowest n no session on the project has. */
function nameFor(project: string): string {
    const taken = new Set(listSessions(project).map(s => s.name))
    let n = 1
    while (taken.has(`${project} ${n}`)) n++
    return `${project} ${n}`
}

function changed(project: string) {
    projectEvents.emit('sessions', project)
}

/** A hook speaking for its session. Says the session as it now is (none once it has ended). */
export function report(input: Report): Session | null {
    const now = new Date().toISOString()
    let session = find(input.id, input.pid)
    const event = input.event === 'Notification'
        ? (/permission|approv|allow/i.test(input.message ?? '') ? 'waiting' : 'idle')
        : STATES[input.event] ?? input.event
    if (event === 'end') {
        if (session) {
            sessions.delete(session.id)
            changed(session.project)
        }
        return null
    }
    const state = (['starting', 'working', 'idle', 'waiting'] as const).find(s => s === event) ?? 'idle'
    if (!session) {
        session = {
            id: input.id ?? `pid-${input.pid}`, pid: input.pid, project: input.project, name: input.name || nameFor(input.project),
            cwd: input.cwd, state, since: now, startedAt: now, listening: false, seenAt: Date.now(),
        }
        sessions.set(session.id, session)
    } else {
        // A session first heard of by its pid gets its real id when a hook brings it.
        if (input.id && session.id !== input.id) {
            sessions.delete(session.id)
            session.id = input.id
            sessions.set(session.id, session)
        }
        if (input.name) session.name = input.name
        session.pid ??= input.pid
        session.cwd ??= input.cwd
        if (session.state !== state) session.since = now
        session.state = state
        session.seenAt = Date.now()
    }
    changed(session.project)
    if (input.command) {
        const {id, project} = session
        for (const write of issueWrites(input.command, project)) {
            useStore().workedBy(write.project, write.issue, id).catch(() => {})
        }
    }
    return publicOf(session)
}

/** The issues a shell command writes to: a curl that sends a body or says PATCH, POST or PUT to an
 * issue's address, `…/projects/<project>/issues/<KEY-n>` (a comment on it too). One whose project isn't
 * spelled out (`$ISSUES/ORR-12`) is in `project`, the session's. */
export function issueWrites(command: string, project: string): {project: string, issue: string}[] {
    const found = new Map<string, {project: string, issue: string}>()
    for (const part of command.split(/&&|\|\||;|\n|\|/)) {
        if (!/\bcurl\b/.test(part) || !/-X\s*['"]?(PATCH|POST|PUT)\b|(^|\s)(-d|--data(-\w+)?)(\s|=|$)/.test(part)) continue
        for (const match of part.matchAll(/(?:\/projects\/([\w.-]+)\/issues)?\/([A-Z][A-Z0-9]*-\d+)\b/g)) {
            const write = {project: match[1] ? decodeURIComponent(match[1]) : project, issue: match[2]!}
            found.set(`${write.project}/${write.issue}`, write)
        }
    }
    return [...found.values()]
}

/** Whether the session is on the project with its channel connected, there to hear a signal now. */
export function hearing(project: string, id: string): boolean {
    const session = sessions.get(id)
    return !!session && session.project === project && session.listening
}

/** The session's channel connecting; `done` marks it gone. `heard` is false when the session wasn't
 * started with the channel flag, so its messages would be dropped; `started` that Orrery started it.
 * Says the session's id. */
export function attend(project: string, id: string | undefined, pid: number | undefined, name: string | undefined, heard = true, started = false): {id: string, done: () => void} {
    let session = find(id, pid)
    if (!session) {
        const now = new Date().toISOString()
        session = {id: id ?? `pid-${pid ?? Math.random().toString(36).slice(2)}`, pid, project, name: name || nameFor(project), state: 'idle', since: now, startedAt: now, listening: heard, seenAt: Date.now()}
        sessions.set(session.id, session)
    }
    session.listening = heard
    if (started) session.started = true
    if (name) session.name = name
    changed(project)
    const held = session
    return {
        id: held.id,
        done: () => {
            held.listening = false
            changed(project)
        },
    }
}

/** How many sessions Orrery started are running, on the project or over all of them. */
export function startedSessions(project?: string): number {
    return listSessions(project).filter(s => s.started).length
}

export function listSessions(project?: string): Session[] {
    const now = Date.now()
    for (const [id, s] of sessions) if (!s.listening && now - s.seenAt > FORGET_AFTER) sessions.delete(id)
    return [...sessions.values()].filter(s => !project || s.project === project)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(publicOf)
}

export function sessionName(id: string | undefined): string | undefined {
    return id ? sessions.get(id)?.name : undefined
}

function publicOf({pid: _pid, seenAt: _seen, ...session}: Known): Session {
    return {...session}
}
