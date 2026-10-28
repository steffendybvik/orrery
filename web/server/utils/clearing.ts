// Sessions Orrery started get a fresh context between pieces of work: once one goes idle with nothing in progress
// and nothing waiting for it, its launcher types `/clear` into it. The process, its tmux session and its channel
// stay. Its hooks' SessionStart brief then hands the fresh context what's left: the issues in progress, and the
// rest of a chunk or scope it was asked to work through (its run). A brief starts no turn, so when some of the run
// is left, a focus on the rest goes to the session alone once it's back (`resumeRun`), and it carries on.
// Any listening session gone idle on an issue whose sub-issues are still to do (it just split it, say) is sent on to
// the most urgent of them (`carryOn`), since nothing else would start its next turn.
import type {Signal} from '#shared/roadmap'

/** How long a session stays idle before it's cleared: a signal its channel has just handed Claude Code starts
 * another turn in that time, and then it isn't cleared. */
export const CLEAR_AFTER = 5000

/** The last chunk or scope focus each session was handed, by the id it had then. */
const runs = new Map<string, Signal>()

/** What was left of each run when it was last resumed: its open issues, each with its status and last change. */
const resumed = new WeakMap<Signal, string>()

/** The sub-issue each session was last sent on to, by its id now, with its status and last change. */
const carried = new Map<string, string>()

/** The note on a focus `carryOn` sends, which tells it from the owner's own. */
export const CARRY_ON = 'Carry on with the sub-issues of the issue you have in progress, most urgent first.'

/** A chunk or scope focus reaching the session: what's left of it is its run until another comes. A focus on one
 * issue ends the run: the owner pointed it elsewhere. Runs of sessions that are gone are let go. */
export function startRun(session: string, signal: Signal) {
    for (const id of runs.keys()) {
        if (!sessionNow(currentId(id))) runs.delete(id)
    }
    if (signal.kind !== 'focus') return
    if (!signal.issue && signal.chunk) runs.set(session, signal)
    // Carrying on with sub-issues is still the run's work: what's left of it waits until they're done.
    else if (signal.issue && signal.note !== CARRY_ON) sessionIds(currentId(session)).forEach(id => runs.delete(id))
}

/** The session Orrery started is back from a `/clear`: if its run has issues left, a focus on them goes to it
 * alone, as the run's was sent (by whom, the statuses and release), so a new turn starts. Says if it sent one.
 * Not when nothing left has changed since the last time: a session that won't take any of it (blocked, or waiting
 * on the owner) would otherwise be cleared and sent it again every few seconds. */
export async function resumeRun(project: string, session: string): Promise<boolean> {
    const run = runOf(session)
    if (!run || run.project !== project || !run.chunk || !sessionNow(session)?.started) return false
    const store = useStore()
    const {open} = await scopeOf(store, project, run)
    if (!open.length) return false
    const left = open.map(t => `${t.id} ${t.column} ${t.updated_at}`).join('\n')
    if (resumed.get(run) === left) return false
    resumed.set(run, left)
    await store.focusChunk(project, run.chunk, {session, status: run.status ?? null, release: run.release ?? null, note: "Carry on with what's left of it after the clear."},
        {name: run.created_by, owner: run.protected})
    return true
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

/** The session went idle: if it's listening, and after a moment it's still idle with no signal waiting, and an issue
 * it has in progress has sub-issues in backlog or todo, a focus on the most urgent goes to it alone, as the owner's,
 * so it carries on with them as it would with a chunk. Not for a session an untrusted schedule's run started, which
 * the owner's word mustn't reach. Not twice for a sub-issue that hasn't changed since: a session that won't take it
 * (blocked, or waiting on the owner) would otherwise be sent it after every turn. */
export function carryOn(project: string, id: string) {
    const before = sessionNow(id)
    if (!before?.listening || before.state !== 'idle' || untrustedSession(id)) return
    setTimeout(async () => {
        try {
            const now = sessionNow(id)
            if (!now?.listening || now.state !== 'idle' || now.idleAt !== before.idleAt) return
            const ids = sessionIds(id)
            const store = useStore()
            if (await store.waiting(now.project, ids)) return
            const parents = new Set((await store.workingOn(now.project, ids)).map(i => i.id))
            if (!parents.size) return
            const next = (await store.listIssues(now.project))
                .filter(i => i.parent && parents.has(i.parent) && (i.kind === 'backlog' || i.kind === 'todo'))
                .sort((a, b) => (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9'))[0]
            if (!next) return
            for (const session of carried.keys()) {
                if (!sessionNow(session)) carried.delete(session)
            }
            const sent = `${next.id} ${next.column} ${next.updated_at}`
            if (carried.get(currentId(id)) === sent) return
            carried.set(currentId(id), sent)
            await store.focus(now.project, next.id, {session: currentId(id), note: CARRY_ON}, {name: (await store.ownerOf()).name, owner: true})
        } catch (error) {
            console.error(`[orrery] carrying ${id} on:`, error)
        }
    }, CLEAR_AFTER)
}
