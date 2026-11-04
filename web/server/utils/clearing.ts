// Sessions orrery started get a fresh context between pieces of work: once one goes idle with nothing in progress
// and nothing waiting for it, its launcher types `/clear` into it. The process, its tmux session and its channel
// stay. Its hooks' SessionStart brief then hands the fresh context what's left: the issues in progress, and the
// rest of a milestone or scope it was asked to work through (its run). A brief starts no turn, so when some of the run
// is left, a focus on the rest goes to the session alone once it's back (`resumeRun`), and it carries on.
// Any listening session gone idle on an issue whose sub-issues are still to do (it just split it, say) is sent on to
// the most urgent of them (`carryOn`), since nothing else would start its next turn. Related work keeps the context
// (ORR-903): one orrery started that has just closed a sub-issue, with a sibling still to do, is sent on to the sibling
// instead of cleared. Anything else, and the sibling it won't take, starts clean. A session whose turn was cut off
// by an API error (the network, a rate limit) lets go of what it had in progress (`letGo`), so none of it sits there
// in progress with nobody on it.
import type {Signal} from '#shared/roadmap'
import {CLOSED, byPriority, isBlocked, modelFor} from '#shared/roadmap'
import {heavyEnough} from './pool'

/** How long a session stays idle before it's cleared: a signal its channel has just handed Claude Code starts
 * another turn in that time, and then it isn't cleared. */
export const CLEAR_AFTER = 5000

/** The last milestone or scope focus each session was handed, by the id it had then. */
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
export const CARRY_ON = 'Carry on with this one, the most urgent next to the issue you just worked (a sub-issue or sibling of it), with what you know from that.'

/** A milestone or scope focus reaching the session: what's left of it is its run until another comes. A focus on one
 * issue ends the run: the owner pointed it elsewhere. Runs of sessions that are gone are let go. */
export function startRun(session: string, signal: Signal) {
    for (const id of runs.keys()) {
        if (!sessionNow(currentId(id))) runs.delete(id)
    }
    if (signal.kind !== 'focus') return
    if (!signal.issue && signal.milestone) runs.set(session, signal)
    // Carrying on with sub-issues is still the run's work: what's left of it waits until they're done.
    else if (signal.issue && signal.note !== CARRY_ON) sessionIds(currentId(session)).forEach(id => runs.delete(id))
}

/** The session orrery started is back from a `/clear`: if its run has issues left, a focus on them goes to it
 * alone, as the run's was sent (by whom, the statuses and release), so a new turn starts. Says if it sent one.
 * Not when nothing left has changed since the last time: a session that won't take any of it (blocked, or waiting
 * on the owner) would otherwise be cleared and sent it again every few seconds. */
export async function resumeRun(project: string, session: string): Promise<boolean> {
    const run = runOf(session)
    if (!run || run.project !== project || !run.milestone || !sessionNow(session)?.started) return false
    const store = useStore()
    const {open} = await scopeOf(store, project, run)
    if (!open.length) return false
    const left = open.map(t => `${t.id} ${t.column} ${t.updated_at}`).join('\n')
    if (resumed.get(run) === left) return false
    resumed.set(run, left)
    await store.focusMilestone(project, run.milestone, {session, status: run.status ?? null, release: run.release ?? null, note: "Carry on with what's left of it after the clear."},
        {name: run.created_by, owner: run.protected, ...run.person ? {person: run.person} : {}})
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
            if (await store.busy(now.project, ids)) return notDue()
            // Its next piece of work is related to the one it just did (a sibling of it): it keeps its context and is
            // sent on to it instead (ORR-903). Once it won't take it, the next idle clears it as before.
            if (await sendOn(now, id)) return notDue()
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
 * so it carries on with them as it would with a milestone. Not for a session an untrusted schedule's run started, which
 * the owner's word mustn't reach. Not twice for a sub-issue that hasn't changed since: a session that won't take it
 * (blocked, or waiting on the owner) would otherwise be sent it after every turn. */
export function carryOn(project: string, id: string) {
    const before = sessionNow(id)
    if (!before?.listening || before.state !== 'idle' || untrustedSession(id) || chatSession(id)) return
    setTimeout(async () => {
        try {
            const now = sessionNow(id)
            if (!now?.listening || now.state !== 'idle' || now.idleAt !== before.idleAt) return
            const store = useStore()
            if (await store.waiting(now.project, sessionIds(id))) return
            // One orrery started with nothing in progress is `considerClear`'s to send on or clear, so the two don't race.
            if (now.started && !(await store.workingOn(now.project, sessionIds(id))).length) return
            await sendOn(now, id)
        } catch (error) {
            console.error(`[orrery] carrying ${id} on:`, error)
        }
    }, CLEAR_AFTER)
}

/** The session's next related piece of work, which it keeps its context for (ORR-903): a sub-issue of an issue it has
 * in progress, or, with none in progress and orrery having started it, a sibling of the one it worked last, now closed. In Backlog or Todo, not
 * blocked, the most urgent first. Only what its own person's to start (ORR-656) and what its model is set for (ORR-868). */
async function nextRelated(now: NonNullable<ReturnType<typeof sessionNow>>, id: string) {
    const ids = sessionIds(id)
    const store = useStore()
    const issues = await store.listIssues(now.project)
    const parents = new Set((await store.workingOn(now.project, ids)).map(i => i.id))
    let after: string | undefined
    // A sibling only for one orrery started, which it would otherwise clear; one opened by hand keeps its context anyway, and picks.
    if (!parents.size) {
        if (!now.started) return undefined
        const lastId = await store.lastWorked(now.project, ids)
        const last = lastId ? issues.find(i => i.id === lastId) : undefined
        if (!last?.parent || !(CLOSED as readonly string[]).includes(last.kind)) return undefined
        parents.add(last.parent)
        after = last.id
    }
    const left = issues
        .filter(i => i.parent && parents.has(i.parent) && i.id !== after && (i.kind === 'backlog' || i.kind === 'todo') && !isBlocked(i))
        .sort(byPriority)
    const kinds = await store.workKinds()
    for (const issue of left) {
        // A lighter session leaves the heavier ones to another.
        if (!heavyEnough({model: modelFor(issue, kinds).model}, now.started?.model)) continue
        const whose = await store.whoseWork(now.project, issue.assignee)
        if (whose === undefined || whose === now.person) return issue
    }
    return undefined
}

/** Sends the listening session on to its next related piece of work (`nextRelated`), alone and as the owner, as a
 * focus with CARRY_ON. Not for an untrusted schedule's run, which the owner's word mustn't reach, or a chat. Not twice
 * for an issue that hasn't changed since: a session that won't take it (blocked, or waiting on the owner) would
 * otherwise be sent it after every turn, and never cleared. Says whether it sent one. */
async function sendOn(now: NonNullable<ReturnType<typeof sessionNow>>, id: string): Promise<boolean> {
    if (!now.listening || untrustedSession(id) || chatSession(id)) return false
    const next = await nextRelated(now, id)
    if (!next) return false
    for (const session of carried.keys()) {
        if (!sessionNow(session)) carried.delete(session)
    }
    const sent = `${next.id} ${next.column} ${next.updated_at}`
    if (carried.get(currentId(id)) === sent) return false
    carried.set(currentId(id), sent)
    const store = useStore()
    await store.focus(now.project, next.id, {session: currentId(id), note: CARRY_ON}, {name: (await store.ownerOf()).name, owner: true})
    return true
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

/** Each issue the session (by `ids`) has in progress goes back to Todo with nobody on it, with a comment saying `what`
 * happened to it, for it or anyone to pick up again. Says which. One in review or waiting on the owner stays: its work is
 * done, and it isn't the session's turn (ORR-646). So does one with one person that's assigned to them: they have it, and
 * the session only touched it. With people it stays its person's, for another of their agents to pick up. */
async function handBack(project: string, ids: string[], name: string, what: string): Promise<string[]> {
    const store = useStore()
    const shared = await store.isShared()
    const issues = []
    for (const issue of await store.workingOn(project, ids)) {
        if (issue.status !== 'in-review' && !issue.waiting && (shared || !issue.assignee || !await store.isPerson(issue.assignee))) issues.push(issue)
    }
    const actor = {name: 'claude', owner: false}
    for (const issue of issues) {
        await store.updateIssue(project, issue.id, shared ? {status: 'todo'} : {status: 'todo', assignee: null}, actor)
        await store.createComment(project, issue.id, {
            body: `The session working on this (${name}) ${what}, so it's back in Todo with nobody on it. Focus a session on it to pick it up again.`,
        }, actor)
    }
    return issues.map(i => i.id)
}

/** The session's turn ended on an API error (`error`, from Claude Code's StopFailure): what it had in progress goes back. */
export async function letGo(project: string, id: string, error?: string): Promise<string[]> {
    const why = error ? CUT_OFF[error] ?? `an API error (${error})` : 'an API error'
    return handBack(project, sessionIds(id), sessionNow(id)?.name ?? id, `had its turn cut off by ${why}`)
}

/** The session has ended, by every id it went by, and didn't come back in time (`handBackSoon`): what it had in progress
 * goes back (ORR-775). */
export async function letGoEnded(project: string, ids: string[], name: string): Promise<string[]> {
    return handBack(project, ids, name, 'ended')
}
