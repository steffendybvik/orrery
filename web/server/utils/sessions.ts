// The Claude sessions working on each project, kept in memory (they're live, not history). A
// session's hooks say who it is and what it's doing (POST /api/sessions); its channel, while
// connected, says it's there to hear signals. Both name the window by Claude Code's session id,
// falling back to the claude process's pid. A `/clear` gives the window a new session id while its
// channel carries on under the old one, so the ids a session had before stay aliases of it. A window
// can run a channel for every project in its repo's `.mcp.json`, only the flagged one heard, so it
// listens (and can be stopped) through its own project's channel only.
import type {Session, SessionState, StartedSession} from '#shared/roadmap'

interface Known extends Session {
    pid?: number
    /** When a hook last spoke. */
    seenAt: number
    /** The project its hooks name: its own once a channel there is heard, whichever channel connected first. */
    hooked?: string
    /** When a hook last said it went idle (finished a turn), for a repeat to wait on. */
    idleAt?: number
    /** Its channels' open streams, by project: how many, how many of them are heard, and how many know to quit
     * when asked. Its own project's say whether it's listening (`listening`) and can be stopped (`stoppable`). */
    channels?: Map<string, {streams: number, heard: number, stops: number}>
    stoppable?: number
    /** The owner asked it to quit: it's dropped once its channel goes. */
    stopping?: boolean
    /** When a `/clear` ended it: the next session to start after a clear on its project and folder is its
     * window, under a new id, when no pid says so. */
    cleared?: number
    /** The launch its channel says Orrery started it for, kept for when Orrery doesn't know that launch yet
     * (Orrery restarted): the launcher's report of it then marks the session started again. */
    launch?: string
}

const sessions = new Map<string, Known>()
/** A session's earlier ids, each to the one it has now. */
const aliases = new Map<string, string>()
// A session nothing has heard from in this long, and that isn't listening, is dropped.
const FORGET_AFTER = 6 * 60 * 60 * 1000
// How long a cleared session waits for the one that takes it over.
const CLEARED_FOR = 60 * 1000

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
    /** For `SessionEnd`: why (`clear` keeps the window, which starts again under a new id). */
    reason?: string
    /** For `SessionStart`: what started it (`clear` after one). */
    source?: string
}

/** The id the session goes by now, for one it had before a `/clear`; any other id as it is. */
export function currentId(id: string): string {
    return aliases.get(id) ?? id
}

/** Every id the session has gone by, its own first. */
export function sessionIds(id: string): string[] {
    const now = currentId(id)
    return [now, ...[...aliases].filter(([, to]) => to === now).map(([from]) => from)]
}

function find(id?: string, pid?: number): Known | undefined {
    const byId = id ? sessions.get(currentId(id)) : undefined
    // `claude --resume` takes an id up again in another window: a session with another pid is another window.
    if (byId && (!pid || !byId.pid || byId.pid === pid)) return byId
    if (pid) return [...sessions.values()].find(s => s.pid === pid)
    return undefined
}

/** The session a `/clear` just ended on the project and in the folder, waiting for its window's next id. */
function clearedIn(project: string, cwd: string | undefined): Known | undefined {
    const since = Date.now() - CLEARED_FOR
    return [...sessions.values()].filter(s => s.project === project && s.cwd === cwd && (s.cleared ?? 0) > since)
        .sort((a, b) => b.cleared! - a.cleared!)[0]
}

/** A session new to Orrery under an id another one had before: that id is its own now. */
function add(session: Known) {
    aliases.delete(session.id)
    sessions.set(session.id, session)
}

/** "<project> <n>", the lowest n no session on the project has. */
function nameFor(project: string): string {
    const taken = new Set(listSessions(project).map(s => s.name))
    let n = 1
    while (taken.has(`${project} ${n}`)) n++
    return `${project} ${n}`
}

function forget(session: Known) {
    sessions.delete(session.id)
    for (const [from, to] of aliases) if (to === session.id) aliases.delete(from)
}

function changed(project: string) {
    projectEvents.emit('sessions', project)
}

/** A hook speaking for its session. Says the session as it now is (none once it has ended). */
export function report(input: Report): Session | null {
    const now = new Date().toISOString()
    let session = find(input.id, input.pid)
    // With no pid to tie them, the session after a clear is the window's that a clear just ended.
    if (!session && input.event === 'SessionStart' && input.source === 'clear') session = clearedIn(input.project, input.cwd)
    const event = input.event === 'Notification'
        ? (/permission|approv|allow/i.test(input.message ?? '') ? 'waiting' : 'idle')
        : STATES[input.event] ?? input.event
    // A `/clear` ends Claude Code's session but not the window: it starts again under a new id, which
    // finds this one by its pid, and its channel goes on listening.
    if (event === 'end' && input.reason !== 'clear') {
        if (session) {
            forget(session)
            changed(session.project)
        }
        return null
    }
    const state = (['starting', 'working', 'idle', 'waiting'] as const).find(s => s === event) ?? 'idle'
    if (!session && event === 'end') return null
    if (!session) {
        session = {
            id: input.id ?? `pid-${input.pid}`, pid: input.pid, project: input.project, name: input.name || nameFor(input.project),
            cwd: input.cwd, state, since: now, started_at: now, listening: false, seenAt: Date.now(), hooked: input.project,
        }
        add(session)
    } else {
        session.hooked = input.project
        // Its channels connected before the hook spoke, and one heard is on the hook's project: that's its own.
        if (!session.started && session.project !== input.project && heardOn(session, input.project)) moveTo(session, input.project)
        // A session first heard of by its pid gets its real id when a hook brings it, and one cleared
        // its new one; the old id stays an alias, as its channel and the issues it worked still use it.
        // An id it had before isn't a new one: its channel still reports with the id it started under, even
        // once another window has resumed under it.
        if (input.id && !sessionIds(session.id).includes(input.id) && !sessions.has(input.id)) {
            const {id: from, project} = session
            sessions.delete(from)
            for (const [old, to] of aliases) if (to === from) aliases.set(old, input.id)
            aliases.set(from, input.id)
            aliases.delete(input.id)
            session.id = input.id
            sessions.set(session.id, session)
            useStore().renameSession(project, from, input.id).catch(error => console.error(`[orrery] moving session ${from} to ${input.id}:`, error))
        }
        session.cleared = event === 'end' ? Date.now() : undefined
        if (input.name) session.name = input.name
        session.pid ??= input.pid
        session.cwd ??= input.cwd
        if (session.state !== state) session.since = now
        session.state = state
        session.seenAt = Date.now()
    }
    if (state === 'idle') session.idleAt = Date.now()
    changed(session.project)
    // Free now: it takes up what was sent to one session while every one was busy (pool.ts).
    if (state === 'idle') projectEvents.emit('session-idle', session.id)
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

/** Whether the session is on the project with its channel connected, there to hear a signal now: its own project,
 * or another its channel also serves (one channel can serve several of a repo's projects). */
export function hearing(project: string, id: string): boolean {
    const session = sessions.get(currentId(id))
    return !!session && heardOn(session, project)
}

function heardOn(session: Known, project: string): boolean {
    return !!session.channels?.get(project)?.heard
}

/** Whether the session belongs with the project on the Sessions page: its own, or one its channel is heard on. */
function covers(session: Known, project: string): boolean {
    return session.project === project || heardOn(session, project)
}

/** Its own project and the others its channel serves, which the Sessions page all lists it under. */
function changedAll(session: Known) {
    for (const project of new Set([session.project, ...session.channels?.keys() ?? []])) changed(project)
}

/** The session's channel connecting; `done` marks it gone. `heard` is false when the session wasn't
 * started with the channel flag, so its messages would be dropped; `started` is the launch Orrery started it for;
 * `stops` when the channel ends its session when the owner stops it (an older one doesn't); `server` the name its server goes by. Says the session's id, the one it
 * has now: a `/clear` changes it while the channel stays connected. */
export function attend(project: string, id: string | undefined, pid: number | undefined, name: string | undefined, heard = true, started?: StartedSession, stops = false, launch?: string, server?: string): {id: string, done: () => void} {
    let session = find(id, pid)
    if (!session) {
        const now = new Date().toISOString()
        session = {id: id ?? `pid-${pid ?? Math.random().toString(36).slice(2)}`, pid, project, name: name || nameFor(project), state: 'idle', since: now, started_at: now, listening: false, seenAt: Date.now()}
        add(session)
    }
    const held = session
    // A skipped channel that connected before the hook spoke filed the window under its project. One channel
    // heard on several projects keeps the one Orrery started it for, else the one its hooks name, else the first
    // it was heard on.
    if (heard && held.project !== project && (started || !held.started && project === held.hooked || !heardOn(held, held.project))) moveTo(held, project)
    held.channels ??= new Map()
    const count = held.channels.get(project) ?? {streams: 0, heard: 0, stops: 0}
    held.channels.set(project, {streams: count.streams + 1, heard: count.heard + Number(heard), stops: count.stops + Number(stops)})
    tally(held)
    if (started) held.started = started
    if (launch) {
        held.launch = launch
        // A focus made for the launch is this session's.
        aliases.set(launchTarget(launch), held.id)
    }
    if (name) held.name = name
    if (server) held.server = server
    changedAll(held)
    let open = true
    return {
        get id() {
            return held.id
        },
        done: () => {
            if (!open) return
            open = false
            const count = held.channels!.get(project)!
            if (count.streams > 1) held.channels!.set(project, {streams: count.streams - 1, heard: count.heard - Number(heard), stops: count.stops - Number(stops)})
            else held.channels!.delete(project)
            tally(held)
            if (!held.channels!.size && held.stopping) forget(held)
            changedAll(held)
            changed(project)
        },
    }
}

/** Files the session under another project as its own. */
function moveTo(session: Known, project: string) {
    changed(session.project)
    if (session.name.startsWith(`${session.project} `)) session.name = nameFor(project)
    session.project = project
    tally(session)
}

/** Listening and stoppable as its own project's channels say: another project's (skipped) don't count. */
function tally(session: Known) {
    const own = session.channels?.get(session.project)
    session.listening = !!own?.heard
    session.stoppable = own?.stops ?? 0
}

/** The owner stopping a session: one Orrery started, through its launcher; any other through its channel,
 * which ends its claude process. One with no channel open is out of reach (only its terminal closes it). */
export function stopSession(project: string, id: string): Session {
    const session = sessions.get(currentId(id))
    if (!session || !covers(session, project)) throw notFound(`No session ${id} in ${project}`)
    // With no launcher connected to stop it, its channel can.
    if (session.started && (launchersOf(project) || !session.stoppable)) return stopLaunch(project, session.started.launch)
    if (!session.stoppable) throw conflict(`${session.name} has no Orrery channel running that can stop it (an older channel needs the session restarted): close it in its terminal`)
    session.stopping = true
    projectEvents.emit('session-stop', {project, id: session.id})
    return publicOf(session)
}

/** How many sessions Orrery started are running, on the project or over all of them: one whose channel
 * has gone (it crashed, or was stopped by hand) no longer counts. */
export function startedSessions(project?: string): number {
    return listSessions(project).filter(s => s.started && s.listening && (!project || s.project === project)).length
}

/** The session Orrery started for the launch, if it's still known. */
export function sessionOfLaunch(project: string, launch: string): Session | undefined {
    const session = [...sessions.values()].find(s => covers(s, project) && s.started?.launch === launch)
    return session && publicOf(session)
}

/** A launch its launcher says it runs: the session started for it counts as started again, with its stop time,
 * if its channel connected before Orrery heard of the launch (Orrery restarted). */
export function adoptLaunch(project: string, started: StartedSession) {
    const session = [...sessions.values()].find(s => covers(s, project) && (s.started?.launch === started.launch || s.launch === started.launch))
    if (!session) return
    session.started = started
    changed(project)
}

/** The launch's session has ended (its launcher stopped it): it's dropped. */
export function launchEnded(project: string, launch: string) {
    const session = [...sessions.values()].find(s => covers(s, project) && s.started?.launch === launch)
    if (!session) return
    forget(session)
    changed(project)
}

/** Moves the launch's stop time; says the session as it now is. */
export function extendLaunch(project: string, launch: string, stops_at: string): Session | undefined {
    const session = [...sessions.values()].find(s => covers(s, project) && s.started?.launch === launch)
    if (!session?.started) return undefined
    session.started = {...session.started, stops_at}
    changed(project)
    return publicOf(session)
}

export function listSessions(project?: string): Session[] {
    const now = Date.now()
    for (const s of [...sessions.values()]) if (!s.listening && now - s.seenAt > FORGET_AFTER) forget(s)
    return [...sessions.values()].filter(s => !project || covers(s, project))
        .sort((a, b) => a.started_at.localeCompare(b.started_at)).map(publicOf)
}

/** The session as it is now, with when its hooks last said it went idle; nothing for one Orrery doesn't know. */
export function sessionNow(id: string): (Session & {idleAt?: number}) | undefined {
    const session = sessions.get(currentId(id))
    return session && {...publicOf(session), idleAt: session.idleAt}
}

/** When the session's hooks last said it went idle; nothing when they never have (no hooks, or none yet). */
export function idleAt(id: string): number | undefined {
    return sessions.get(currentId(id))?.idleAt
}

export function sessionName(id: string | undefined): string | undefined {
    return id ? sessions.get(currentId(id))?.name : undefined
}

function publicOf({pid: _pid, seenAt: _seen, idleAt: _idle, hooked: _hooked, channels, stoppable, stopping: _stopping, cleared: _cleared, ...session}: Known): Session {
    const others = [...channels ?? []].filter(([project, c]) => c.heard && project !== session.project).map(([project]) => project)
    return {...session, reachable: !!stoppable, ...others.length ? {also: others} : {}}
}
