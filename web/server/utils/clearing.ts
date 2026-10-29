// Sessions orrery started get a fresh context between pieces of work: once one goes idle with nothing in progress
// and nothing waiting for it, its launcher types `/clear` into it. The process, its tmux session and its channel
// stay. Its hooks' SessionStart brief then hands the fresh context what's left: the issues in progress, and the
// rest of a chunk or scope it was asked to work through (its run). A brief starts no turn, so when some of the run
// is left, a focus on the rest goes to the session alone once it's back (`resumeRun`), and it carries on.
// Any listening session gone idle on an issue whose sub-issues are still to do (it just split it, say) is sent on to
// the most urgent of them (`carryOn`), since nothing else would start its next turn. A session whose turn was cut off
// by an API error (the network, a rate limit) lets go of what it had in progress (`letGo`), so none of it sits there
// in progress with nobody on it.
import type {Signal} from '#shared/roadmap'
import {byPriority} from '#shared/roadmap'

/** How long a session stays idle before it's cleared: a signal its channel has just handed Claude Code starts
 * another turn in that time, and then it isn't cleared. */
export const CLEAR_AFTER = 5000

/** The last chunk or scope focus each session was handed, by the id it had then. */
const runs = new Map<string, Signal>()

/** What was left of each run when it was last resumed: its open issues, each with its status and last change. */
const resumed = new WeakMap<Signal, string>()

/** Sessions orrery started that went idle and are due a clear, by their id then, with when: picking hands them
 * nothing until it's done or not needed, as a turn started first skips the clear (ORR-527). */
const clearDue = new Map<string, number>()

/** How long a due clear holds a session back from picking at most, so a launcher that never clears it doesn't. */
export const CLEAR_DUE_FOR = 60_000

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

/** The session orrery started is back from a `/clear`: if its run has issues left, a focus on them goes to it
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

/** Whether the session is waiting on a clear `considerClear` has coming, by any id it has gone by. */
export function clearPending(id: string): boolean {
    return sessionIds(id).some(known => Date.now() - (clearDue.get(known) ?? -Infinity) < CLEAR_DUE_FOR)
}

/** The session is back from its clear: nothing holds it back from picking now. */
export function clearDone(id: string) {
    for (const known of sessionIds(id)) clearDue.delete(known)
}

/** The session went idle: if orrery started it, and after a moment it's still idle, with no issue in progress
 * and no signal waiting for it, its launcher clears it. Until then it's due one (`clearPending`). */
export function considerClear(project: string, id: string) {
    const before = sessionNow(id)
    // A chat keeps its conversation.
    if (!before?.started || before.started.chat || before.state !== 'idle') return
    for (const [known, at] of clearDue) {
        if (Date.now() - at >= CLEAR_DUE_FOR) clearDue.delete(known)
    }
    const due = Date.now()
    clearDue.set(id, due)
    // Not cleared after all: picking may hand it work, unless a later idle has made it due again.
    const notDue = () => clearDue.get(id) === due && clearDue.delete(id)
    setTimeout(async () => {
        try {
            const now = sessionNow(id)
            if (!now?.started || now.state !== 'idle' || now.idleAt !== before.idleAt) return notDue()
            const ids = sessionIds(id)
            const store = useStore()
            if ((await store.workingOn(now.project, ids)).length || await store.waiting(now.project, ids)) return notDue()
            projectEvents.emit('launches', {type: 'clear', project: now.project, id: now.started.launch})
            // A clear that never comes back (its launcher gone) lets it pick again once the mark runs out.
            setTimeout(() => {
                if (notDue()) recheckIdle()
            }, CLEAR_DUE_FOR)
        } catch (error) {
            notDue()
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
    if (!before?.listening || before.state !== 'idle' || untrustedSession(id) || chatSession(id)) return
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
                .sort(byPriority)[0]
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

/** What a cut-off turn's `error` (Claude Code's StopFailure) says, for the comment; any other as it is. */
const CUT_OFF: Record<string, string> = {
    rate_limit: 'a rate limit',
    overloaded: 'the model being overloaded',
    server_error: 'an API server error',
    authentication_failed: 'a failed sign-in',
    billing_error: 'a billing error',
    max_output_tokens: 'the output limit',
}

/** The session's turn ended on an API error (`error`, from Claude Code's StopFailure): each issue it has in progress
 * goes back to Todo with nobody on it, with a comment saying why, for it or anyone to pick up again. Says which. */
export async function letGo(project: string, id: string, error?: string): Promise<string[]> {
    const store = useStore()
    const issues = await store.workingOn(project, sessionIds(id))
    const why = error ? CUT_OFF[error] ?? `an API error (${error})` : 'an API error'
    const actor = {name: 'claude', owner: false}
    for (const issue of issues) {
        await store.updateIssue(project, issue.id, {status: 'todo', assignee: null}, actor)
        await store.createComment(project, issue.id, {
            body: `The session working on this (${sessionNow(id)?.name ?? id}) had its turn cut off by ${why}, so it's back in Todo with nobody on it. Focus a session on it to pick it up again.`,
        }, actor)
    }
    return issues.map(i => i.id)
}
