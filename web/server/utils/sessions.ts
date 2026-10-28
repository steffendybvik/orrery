// The Claude sessions working on each project, kept in memory (they're live, not history). A
// session's hooks say who it is and what it's doing (POST /api/sessions); its channel, while
// connected, says it's there to hear signals. Both name the window by Claude Code's session id,
// falling back to the claude process's pid. A `/clear` gives the window a new session id while its
// channel carries on under the old one, so the ids a session had before stay aliases of it. A window
// can run a channel for every project in its repo's `.mcp.json`, only the flagged one heard, so it
// listens (and can be stopped) through its own project's channel only.
import {randomInt} from 'node:crypto'
import type {Session, SessionState, StartedSession} from '#shared/roadmap'
import {SESSION_NAMES, madeUpName} from '#shared/roadmap'

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
    /** The launch its channel says orrery started it for, kept for when orrery doesn't know that launch yet
     * (orrery restarted): the launcher's report of it then marks the session started again. */
    launch?: string
    /** Its channel said it's an untrusted schedule's session: it's held to that whatever orrery knows of its launch. */
    untrusted?: boolean
    /** Its channel said it's the owner's chat: the same, for that. */
    chat?: boolean
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
    // In place of Stop when the turn ended on an API error (rate limit, overloaded, the network…).
    StopFailure: 'idle',
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
        .sort((a, b) => (b.cleared ?? 0) - (a.cleared ?? 0))[0]
}

/** A session new to orrery under an id another one had before: that id is its own now. */
function add(session: Known) {
    aliases.delete(session.id)
    sessions.set(session.id, session)
}

/** "<project> · <name>", the next of NAME_ORDER no session on the project has; past them all, "Odin II" and on.
 * With `spanning`, for a session that hears several projects, the bare name ("Odin"), the next no session has: no
 * one project is its. */
function nameFor(project: string, spanning = false): string {
    const taken = new Set((spanning ? [...sessions.values()] : listSessions(project)).map(s => s.name))
    for (let round = 1; ; round++) {
        for (let k = 0; k < NAME_ORDER.length; k++) {
            const at = (turn + k) % NAME_ORDER.length
            const name = `${spanning ? '' : `${project} · `}${NAME_ORDER[at]}${round > 1 ? ` ${roman(round)}` : ''}`
            if (taken.has(name)) continue
            turn = at + 1
            return name
        }
    }
}

/** Whether its channel is heard on more than one project. */
const spans = (session: Known) => [...session.channels?.values() ?? []].filter(c => c.heard).length > 1

/** A made-up name kept to what the session hears: bare while it hears several projects, "<project> · …" once it's
 * down to one (or moved to another), and left alone while it still fits. */
function rename(session: Known) {
    if (!madeUpName(session)) return
    const spanning = spans(session)
    if (spanning === !session.name.includes(' · ') && (spanning || session.name.startsWith(`${session.project} · `))) return
    session.name = nameFor(session.project, spanning)
}

/** The names in the order they're handed out: each 29 on from the one before (the list's 79 is prime, so every one comes
 * round once), which scatters the families (Odin, Njord, Brokk, Idun…) rather than walking them one by one. */
export const NAME_ORDER: string[] = SESSION_NAMES.map((name, i) => ({name, at: i * 30 % SESSION_NAMES.length})) // 30: 29's inverse, mod 79
    .sort((a, b) => a.at - b.at).map(n => n.name)
/** Where in NAME_ORDER the next name is looked for: after the last handed out, so they rotate, starting somewhere new
 * each time orrery starts. */
let turn = randomInt(NAME_ORDER.length)

/** 2 → II, 14 → XIV. */
function roman(n: number): string {
    const digits: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
    let out = ''
    for (const [value, digit] of digits) for (; n >= value; n -= value) out += digit
    return out
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
    // What it's about to run names the issues it writes to, unless it's an untrusted schedule's: that one writes to
    // none but its proposals, and a command's text is what it read.
    if (input.command && !untrustedSession(session.id)) {
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
            if (!match[2]) continue
            const write = {project: match[1] ? decodeURIComponent(match[1]) : project, issue: match[2]}
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
 * started with the channel flag, so its messages would be dropped; `started` is the launch orrery started it for;
 * `stops` when the channel ends its session when the owner stops it (an older one doesn't); `server` the name its server goes by;
 * `untrusted` when its channel says it's an untrusted schedule's, and `chat` the owner's chat, which it stays. Says the
 * session's id, the one it has now: a `/clear` changes it while the channel stays connected. */
export function attend(project: string, id: string | undefined, pid: number | undefined, name: string | undefined, heard = true, started?: StartedSession, stops = false, launch?: string, server?: string, untrusted = false, chat = false): {id: string, done: () => void} {
    let session = find(id, pid)
    if (!session) {
        const now = new Date().toISOString()
        session = {id: id ?? `pid-${pid ?? Math.random().toString(36).slice(2)}`, pid, project, name: name || nameFor(project), state: 'idle', since: now, started_at: now, listening: false, seenAt: Date.now()}
        add(session)
    }
    const held = session
    // A skipped channel that connected before the hook spoke filed the window under its project. One channel
    // heard on several projects keeps the one orrery started it for, else the one its hooks name, else the first
    // it was heard on.
    if (heard && held.project !== project && (started || !held.started && project === held.hooked || !heardOn(held, held.project))) moveTo(held, project)
    held.channels ??= new Map()
    const count = held.channels.get(project) ?? {streams: 0, heard: 0, stops: 0}
    held.channels.set(project, {streams: count.streams + 1, heard: count.heard + Number(heard), stops: count.stops + Number(stops)})
    tally(held)
    if (started) held.started = started
    if (untrusted || started?.untrusted) held.untrusted = true
    if (chat || started?.chat) held.chat = true
    if (launch) {
        held.launch = launch
        // A focus made for the launch is this session's.
        aliases.set(launchTarget(launch), held.id)
    }
    if (name) held.name = name
    else rename(held)
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
            const channels = held.channels
            const count = channels?.get(project)
            if (!channels || !count) return
            if (count.streams > 1) channels.set(project, {streams: count.streams - 1, heard: count.heard - Number(heard), stops: count.stops - Number(stops)})
            else channels.delete(project)
            tally(held)
            rename(held)
            if (!channels.size && held.stopping) forget(held)
            changedAll(held)
            changed(project)
        },
    }
}

/** Files the session under another project as its own. */
function moveTo(session: Known, project: string) {
    changed(session.project)
    const named = madeUpName(session)
    session.project = project
    if (named && !spans(session)) session.name = nameFor(project)
    tally(session)
}

/** Listening and stoppable as its own project's channels say: another project's (skipped) don't count. */
function tally(session: Known) {
    const own = session.channels?.get(session.project)
    session.listening = !!own?.heard
    session.stoppable = own?.stops ?? 0
}

/** The owner stopping a session: one orrery started, through its launcher; any other through its channel,
 * which ends its claude process. One with no channel open is out of reach (only its terminal closes it). */
export function stopSession(project: string, id: string): Session {
    const session = sessions.get(currentId(id))
    if (!session || !covers(session, project)) throw notFound(`No session ${id} in ${project}`)
    // With no launcher connected to stop it, its channel can.
    if (session.started && (launchersOf(project) || !session.stoppable)) return stopLaunch(project, session.started.launch)
    if (!session.stoppable) throw conflict(`${session.name} has no orrery channel running that can stop it (an older channel needs the session restarted): close it in its terminal`)
    session.stopping = true
    projectEvents.emit('session-stop', {project, id: session.id})
    return publicOf(session)
}

/** How many sessions orrery started are running, on the project or over all of them: one whose channel
 * has gone (it crashed, or was stopped by hand) no longer counts. */
export function startedSessions(project?: string): number {
    // A chat takes up no room.
    return listSessions(project).filter(s => s.started && !s.started.chat && s.listening && (!project || s.project === project)).length
}

/** The session orrery started for the launch, if it's still known. */
export function sessionOfLaunch(project: string, launch: string): Session | undefined {
    const session = [...sessions.values()].find(s => covers(s, project) && s.started?.launch === launch)
    return session && publicOf(session)
}

/** A launch its launcher says it runs: the session started for it counts as started again, with its stop time,
 * if its channel connected before orrery heard of the launch (orrery restarted). */
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

/** The sessions a message to every session reaches: each listening one once, however many projects it hears, in
 * `states` (idle when left out), on any of `projects` (its own or one it also hears) when given. A chat hears only
 * its own. */
export function recipients(projects?: string[], states: SessionState[] = ['idle']): Session[] {
    return listSessions().filter(s => s.listening && !chatSession(s.id) && states.includes(s.state)
        && (!projects?.length || projects.some(p => s.project === p || s.also?.includes(p))))
}

/** The session as it is now, with when its hooks last said it went idle; nothing for one orrery doesn't know. */
export function sessionNow(id: string): (Session & {idleAt?: number}) | undefined {
    const session = sessions.get(currentId(id))
    return session && {...publicOf(session), idleAt: session.idleAt}
}

/** Whether the session (by any id it has had) was started for an untrusted schedule's run. */
export function untrustedSession(id: string): boolean {
    const session = sessions.get(currentId(id))
    return !!session?.untrusted || !!session?.started?.untrusted
}

/** Whether it's the owner's chat (chats.ts), by its channel's word or its launch's. */
export function chatSession(id: string): boolean {
    const session = sessions.get(currentId(id))
    return !!session?.chat || !!session?.started?.chat
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
