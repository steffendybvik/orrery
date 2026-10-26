// Sessions Orrery started get a fresh context between pieces of work: once one goes idle with nothing in progress
// and nothing waiting for it, its launcher types `/clear` into it. The process, its tmux session and its channel
// stay. Its hooks' SessionStart brief then hands the fresh context what's left: the issues in progress, and the
// rest of a chunk or scope it was asked to work through (its run).
import type {Signal} from '#shared/roadmap'

/** How long a session stays idle before it's cleared: a signal its channel has just handed Claude Code starts
 * another turn in that time, and then it isn't cleared. */
export const CLEAR_AFTER = 5000

/** The last chunk or scope focus each session was handed, by the id it had then. */
const runs = new Map<string, Signal>()

/** A chunk or scope focus reaching the session: what's left of it is its run until another comes. */
export function startRun(session: string, signal: Signal) {
    if (signal.kind === 'focus' && !signal.issue && signal.chunk) runs.set(session, signal)
}

/** The session's run, by any id it has gone by. */
export function runOf(session: string): Signal | undefined {
    return sessionIds(session).map(id => runs.get(id)).find(Boolean)
}

/** The session went idle: if Orrery started it, and after a moment it's still idle, with no issue in progress
 * and no signal waiting for it, its launcher clears it. */
export function considerClear(project: string, id: string) {
    const before = sessionNow(id)
    if (!before?.started || before.state !== 'idle') return
    setTimeout(async () => {
        try {
            const now = sessionNow(id)
            if (!now?.started || now.state !== 'idle' || now.idleAt !== before.idleAt) return
            const ids = sessionIds(id)
            const store = useStore()
            if ((await store.workingOn(now.project, ids)).length || await store.waiting(now.project, ids)) return
            projectEvents.emit('launches', {type: 'clear', project: now.project, id: now.started.launch})
        } catch (error) {
            console.error(`[orrery] clearing ${id}:`, error)
        }
    }, CLEAR_AFTER)
}
