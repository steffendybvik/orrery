// Sessions Orrery starts itself, with no terminal. When the owner's signal reaches a project nobody is
// listening on, and the owner lets the project have sessions started (its `starts`), Orrery asks the
// project's launcher (channel/orrery-launcher.mjs, running on the host in the repo) to start one in tmux:
// within the project's limit, and the Orrery's (`sessionLimit`) over every project. The started session's
// channel catches up from that signal, and the launcher stops the session after the project's minutes.
import {randomBytes} from 'node:crypto'
import type {Signal} from '#shared/roadmap'

/** What a launcher is asked to start: `after` is the signal before the one it's for, for its channel to catch up from. */
export interface Launch {
    id: string
    project: string
    after: number
    minutes: number
}

/** Launches asked for whose session hasn't connected yet; one that never does is let go after a while. */
const pending = new Map<string, Launch & {at: number}>()
const PENDING_FOR = 3 * 60 * 1000
/** How many launchers each project has connected. */
const launchers = new Map<string, number>()

export function launchersOf(project: string): number {
    return launchers.get(project) ?? 0
}

/** Counts a project's launcher in until `done` is called. */
export function addLauncher(project: string): () => void {
    launchers.set(project, launchersOf(project) + 1)
    let counted = true
    return () => {
        if (!counted) return
        counted = false
        launchers.set(project, Math.max(0, launchersOf(project) - 1))
    }
}

function pendingOn(project?: string): number {
    for (const [id, launch] of pending) if (Date.now() - launch.at > PENDING_FOR) pending.delete(id)
    return [...pending.values()].filter(l => !project || l.project === project).length
}

/** Starts a session for the signal if it's the owner's, nobody on its project is there to hear it, the owner
 * lets the project have sessions started, a launcher is there to start one, and the limits allow it. One
 * launch on its way covers every signal after it, as its channel catches up from the first. */
export async function considerLaunch(signal: Signal): Promise<Launch | null> {
    const {project} = signal
    if (!signal.protected || signal.deliveredTo.length || listening(project) || !launchersOf(project) || pendingOn(project)) return null
    const store = useStore()
    const {starts} = await store.project(project)
    if (!starts || startedSessions(project) >= starts.limit) return null
    if (startedSessions() + pendingOn() >= (await store.settings()).sessionLimit) return null
    const launch = {id: randomBytes(6).toString('hex'), project, after: signal.id - 1, minutes: starts.minutes}
    pending.set(launch.id, {...launch, at: Date.now()})
    projectEvents.emit('launch', launch)
    return launch
}

/** The launch's session connected: it counts as a started session from now on. */
export function launched(id: string) {
    pending.delete(id)
}

/** For the project's settings: its launchers, and the sessions it has started and on their way. */
export function launchState(project: string): {launchers: number, started: number, starting: number} {
    return {launchers: launchersOf(project), started: startedSessions(project), starting: pendingOn(project)}
}
