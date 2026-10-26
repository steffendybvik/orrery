// Sessions Orrery starts itself, with no terminal. When the owner's signal reaches a project nobody is
// listening on, and the owner lets the project have sessions started (its `starts`), Orrery asks the
// project's launchers (channel/orrery-launcher.mjs, running on the host in the repo) to start one in tmux,
// within the project's limit. The first launcher to
// claim the launch starts it; its channel catches up from that signal, and the launcher stops the session
// after the project's minutes, or when the owner stops it.
import {randomBytes} from 'node:crypto'
import type {Session, SessionContext, Signal} from '#shared/roadmap'
import type {Actor} from './store'

/** What a launcher is asked to start: `after` is the signal before the one it's for, for its channel to
 * catch up from; `tmux` names the tmux session it runs in; `context` what the owner gave it to go on. */
export interface Launch {
    id: string
    project: string
    after: number
    minutes: number
    tmux: string
    context?: SessionContext
}

/** What goes down a project's launcher stream: a session to start, or one of its sessions to stop, keep longer, or
 * clear (`/clear`, a fresh context between pieces of work). */
export type LaunchEvent =
    | {type: 'launch', launch: Launch}
    | {type: 'stop', project: string, id: string}
    | {type: 'extend', project: string, id: string, stops_at: string}
    | {type: 'clear', project: string, id: string}

/** Launches asked for whose session hasn't connected yet; one that never does is let go after a while.
 * `claimed` once a launcher has taken it on. */
const pending = new Map<string, Launch & {at: number, claimed: boolean}>()
const PENDING_FOR = 3 * 60 * 1000
/** The launches its launchers say they run, kept across this server's restarts by the launchers themselves:
 * each reports its sessions when it connects, so one that reconnects to a restarted Orrery is known again. */
const reported = new Map<string, {project: string, tmux: string, stops_at: string, context?: SessionContext}>()
/** How many launchers each project has connected. */
const launchers = counter('launchers')
export const launchersOf = launchers.count
/** Counts a project's launcher in until `done` is called. */
export const addLauncher = launchers.add

function pendingOn(project?: string): number {
    for (const [id, launch] of pending) if (Date.now() - launch.at > PENDING_FOR) pending.delete(id)
    return [...pending.values()].filter(l => !project || l.project === project).length
}

function emit(event: LaunchEvent) {
    projectEvents.emit('launches', event)
}

/** Starts a session for the signal if it's the owner's, nobody on its project is there to hear it, the owner
 * lets the project have sessions started, a launcher is there to start one, and the limits allow it. One
 * launch on its way covers every signal after it, as its channel catches up from the first. The launch is
 * held from the first check, so signals that come together start one session, not one each. */
export async function considerLaunch(signal: Signal): Promise<Launch | null> {
    const {project} = signal
    // One aimed at a session only that session hears, and a delivered one has been heard.
    if (!signal.protected || signal.target || signal.delivered_to.length) return null
    if (listening(project) || !launchersOf(project) || pendingOn(project)) return null
    const id = randomBytes(6).toString('hex')
    const held = {id, project, after: signal.id - 1, minutes: 0, tmux: `orrery-${project}-${id}`.replace(/[^\w-]/g, '-'), at: Date.now(), claimed: false}
    pending.set(id, held)
    const minutes = await allowedMinutes(project).catch(error => {
        pending.delete(id)
        throw error
    })
    if (!minutes) {
        pending.delete(id)
        return null
    }
    held.minutes = minutes
    const {at: _at, claimed: _claimed, ...launch} = held
    emit({type: 'launch', launch})
    return launch
}

/** The session id a focus made for a launch is aimed at: its session takes it as one of its ids when it connects,
 * so no other session hears it. */
export const launchTarget = (launch: string) => `launch-${launch}`

/** The owner starting a session on the project by hand, though nobody's work is waiting: it catches up from the
 * project's latest signal; given an `issue`, from a focus on it made for this session alone; given a scope
 * (`statuses`, `release`), from a focus on the project's issues in it, made the same way. Needs the
 * project's opt-in and a launcher, and counts the sessions on their way against the limit, as it doesn't stand
 * in for them the way a signal's launch does. */
export async function startLaunch(project: string, {issue, statuses, release, context, actor}: {issue?: string, statuses?: string[], release?: string, context?: SessionContext, actor?: Actor} = {}): Promise<Launch> {
    const starts = await useStore().starts(project)
    if (!starts) throw conflict(`${project} doesn't let Orrery start sessions; turn it on from its Sessions tab`)
    if (!launchersOf(project)) throw conflict(`No launcher is running for ${project}: install one in its repo with node channel/orrery-launcher.mjs --install`)
    if (startedSessions(project) + pendingOn(project) >= starts.limit) throw conflict(`${project} already has its ${starts.limit} session${starts.limit === 1 ? '' : 's'} at once`)
    const id = randomBytes(6).toString('hex')
    // Held from here, so the limit counts it while its focus is made.
    const held = {id, project, after: 0, minutes: starts.minutes, tmux: `orrery-${project}-${id}`.replace(/[^\w-]/g, '-'), ...context ? {context} : {}, at: Date.now(), claimed: false}
    pending.set(id, held)
    try {
        const session = launchTarget(id)
        held.after = issue
            ? (await useStore().focus(project, issue, {session}, actor)).id - 1
            : statuses?.length || release
                ? (await useStore().focusChunk(project, 'all', {session, status: (statuses?.length ? statuses : SCOPE_STATUSES).join(','), release: release ?? null}, actor)).id - 1
                : await useStore().lastSignal(project)
    } catch (error) {
        pending.delete(id)
        throw error
    }
    const {at: _at, claimed: _claimed, ...launch} = held
    emit({type: 'launch', launch})
    return launch
}

/** The context a session is started with: the presets picked (by id, the Orrery's or the project's own), then the
 * owner's own words; none when there's neither. */
export async function contextFor(project: string, presets: number[] = [], instructions = ''): Promise<SessionContext | undefined> {
    const picked = await useStore().presetsFor(project, presets)
    const own = instructions.trim()
    const text = [...picked.map(p => p.text), own].filter(Boolean).join('\n\n')
    return text ? {presets: picked.map(p => p.name), ...own ? {instructions: own} : {}, text} : undefined
}

/** The context as the session is told it, with a signal or after a `/clear`. */
export const contextBlock = (context: SessionContext) =>
    `The owner gave this session more context as they started it; it holds for all its work:\n\n${context.text}`

/** The context the launch's session was started with, while Orrery knows the launch. */
export function launchContext(project: string, id: string): SessionContext | undefined {
    const known = pending.get(id) ?? reported.get(id)
    if (known) return known.project === project ? known.context : undefined
    return sessionOfLaunch(project, id)?.started?.context
}

/** What a session started with a scope but no statuses works through: the open work that's ready. */
export const SCOPE_STATUSES = ['todo', 'started']

/** The minutes a new session on the project gets; none when the owner hasn't let it have sessions started,
 * or its limit is reached. */
async function allowedMinutes(project: string): Promise<number | null> {
    const starts = await useStore().starts(project)
    return starts && startedSessions(project) < starts.limit ? starts.minutes : null
}

/** A launcher taking the launch on: only the first gets it, so several launchers start one session between them. */
export function claim(project: string, id: string): boolean {
    const launch = pending.get(id)
    if (!launch || launch.project !== project || launch.claimed) return false
    launch.claimed = true
    return true
}

/** The launch's session connected: it counts as a started session from now on. Says what it was started as. */
export function launched(id: string): {launch: string, tmux: string, stops_at: string} | undefined {
    const launch = pending.get(id)
    pending.delete(id)
    if (launch) return {launch: id, tmux: launch.tmux, stops_at: new Date(Date.now() + launch.minutes * 60_000).toISOString(), ...launch.context ? {context: launch.context} : {}}
    const known = reported.get(id)
    return known && {launch: id, tmux: known.tmux, stops_at: known.stops_at, ...known.context ? {context: known.context} : {}}
}

/** A launcher saying which of the project's sessions it runs, as it connects: they count as started again,
 * with their stop times and context, whether their channels connected before this or connect after. The context
 * it keeps counts only for a launch Orrery has forgotten (it restarted): what Orrery knows stands. */
export function reportRunning(project: string, launches: {id: string, tmux: string, stops_at: string, context?: SessionContext}[]) {
    for (const {id, tmux, stops_at, context: kept} of launches) {
        const context = launchContext(project, id) ?? kept
        reported.set(id, {project, tmux, stops_at, ...context ? {context} : {}})
        adoptLaunch(project, {launch: id, tmux, stops_at, ...context ? {context} : {}})
    }
}

/** The launch has ended, whether or not its session ever connected: it no longer holds the project's place. */
export function launchGone(id: string) {
    pending.delete(id)
    reported.delete(id)
}

/** The owner stopping a session Orrery started: its launcher kills it, and says when it's gone. */
export function stopLaunch(project: string, id: string): Session {
    const session = sessionOfLaunch(project, id)
    if (!session) throw notFound(`No session started for launch ${id} in ${project}`)
    emit({type: 'stop', project, id})
    return session
}

/** The owner giving a session Orrery started more time: `minutes` from when it would have stopped, or from now if that's past. */
export function extendLaunchBy(project: string, id: string, minutes: number): Session {
    const session = sessionOfLaunch(project, id)
    if (!session?.started) throw notFound(`No session started for launch ${id} in ${project}`)
    const from = Math.max(Date.now(), Date.parse(session.started.stops_at))
    const stopsAt = new Date(from + minutes * 60_000).toISOString()
    emit({type: 'extend', project, id, stops_at: stopsAt})
    const known = reported.get(id)
    if (known) known.stops_at = stopsAt
    return extendLaunch(project, id, stopsAt)!
}

/** For the project's settings: its launchers, and the sessions it has started and on their way. */
export function launchState(project: string): {launchers: number, started: number, starting: number} {
    return {launchers: launchersOf(project), started: startedSessions(project), starting: pendingOn(project)}
}
