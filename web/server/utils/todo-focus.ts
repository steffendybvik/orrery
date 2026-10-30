// The owner moving an issue into Todo, or making one there, hands it to an idle session at once (ORR-515), without
// Focus on this and whether or not sessions pick their next issue (`pick_next`). Each issue goes, as a focus aimed at
// it, to a different idle listening session out of work: one session per issue, and never one that's busy, so a
// working session isn't interrupted. With nobody idle, the issue waits in Todo as before: nothing is queued and no
// session is started. A burst of moves (a bulk move to Todo) is collected first, so the most urgent go out first and
// no session is handed two. An agent's move, a schedule run's or an untrusted session's sends nothing: only the
// owner's signals reach sessions.
//
// What depends on another issue (ORR-601) follows it the same way. When an issue's last blocker is done, or a link
// holding it is dropped (by hand, or with the blocker deleted), it's handed out as if it had just landed in Todo: to
// the session that did the blocker first, when it has nothing else in progress, so it carries what it learned on; else
// to an idle one. That goes whoever did the blocker (an agent, mostly), as the owner put it in Todo, but not for a
// schedule run's or an untrusted session's write. A blocker canceled keeps what depends on it blocked and asks the
// owner what to do; one reopened tells the session working on what depends on it.
import type {OrreryEvent} from '#shared/happenings'
import {CLOSED, isBlocked, linkRef} from '#shared/roadmap'
import type {IssueRecord} from '../store/schema'
import {forSessions} from './pick'

/** How long after the owner's move the issues are handed out, so a burst is one hand-out. */
export const TODO_AFTER = 1500

/** The note the focus goes with. */
export const TODO_NOTE = 'It just landed in Todo.'

/** The note an unblocked issue's focus goes with, after the blockers it waited on. */
export const UNBLOCKED_NOTE = 'What it was waiting on is done now, so it can start:'

/** Who moved an issue, and, when that's a member (ORR-658), that it goes only to their own sessions. */
type TodoMove = {from?: string, by: string, member?: string}

/** The issues the owner moved into (or made in) Todo since the last hand-out, by project: each with the status it
 * left (none when it was made), and who moved it. */
const moved = new Map<string, Map<string, TodoMove>>()
/** What may have changed what's blocked since the last hand-out, by project: issues that moved status (from and to),
 * which may free, hold or reopen what depends on them, and ones whose links were dropped, which may free themselves. */
const relinked = new Map<string, Map<string, {from?: string, to?: string, links?: true}>>()
let timer: ReturnType<typeof setTimeout> | undefined

const RANK = {P0: 0, P1: 1, P2: 2, P3: 3}

/** What the store said happened: the owner's move of an issue into some status, or an issue they made, is kept for
 * the next hand-out (whether it's in Todo is read then); anyone's move or dropped link, for what it unblocks. A
 * schedule run's (`cause`) or an untrusted session's isn't, nor is an agent's move into Todo. */
export function heardTodo({event, cause}: {event: OrreryEvent, cause?: unknown}) {
    if (cause || event.untrusted || !event.project || !event.subject) return
    const change = {...event.from ? {from: event.from} : {}, ...event.to ? {to: event.to} : {}}
    if (event.type === 'issue.status') keep(relinked, event.project, event.subject, change)
    if (event.type === 'issue.depends' && dropped(event.from, event.to)) keep(relinked, event.project, event.subject, {links: true})
    if ((event.by?.owner || event.by?.person) && (event.type === 'issue.status' || event.type === 'issue.created')) {
        keep(moved, event.project, event.subject, {...event.type === 'issue.status' && event.from ? {from: event.from} : {}, by: event.by.name, ...event.by.person ? {member: event.by.person} : {}})
    }
    if (!moved.size && !relinked.size) return
    timer ??= setTimeout(() => {
        timer = undefined
        const now = [...moved]
        const linked = [...relinked]
        moved.clear()
        relinked.clear()
        void (async () => {
            for (const [project, issues] of now) {
                await handTodo(project, issues).catch(error => console.error(`[orrery] handing ${project}'s Todo to idle sessions:`, error))
            }
            for (const [project, issues] of linked) {
                await handUnblocked(project, issues).catch(error => console.error(`[orrery] handing out what ${project}'s issues unblocked:`, error))
            }
        })()
    }, TODO_AFTER)
}

function keep<T>(into: Map<string, Map<string, T>>, project: string, issue: string, what: T) {
    const issues = into.get(project) ?? new Map<string, T>()
    into.set(project, issues.set(issue, {...issues.get(issue), ...what}))
}

/** Whether a `depends` change (JSON lists of refs, or none) took a link away. */
function dropped(from?: string, to?: string): boolean {
    const list = (json?: string): string[] => json ? JSON.parse(json) as string[] : []
    const after = list(to)
    return list(from).some(ref => !after.includes(ref))
}

/** The idle listening sessions on `project` out of work, not a chat or an untrusted one's, the project's own first. */
async function idleSessions(project: string): Promise<ReturnType<typeof listSessions>> {
    const store = useStore()
    const idle: ReturnType<typeof listSessions> = []
    for (const session of listSessions().filter(s => s.listening && s.state === 'idle' && hears(s, project))) {
        if (chatSession(session.id) || untrustedSession(session.id)) continue
        if (await store.busy(project, sessionIds(session.id))) continue
        idle.push(session)
    }
    return idle.sort((a, b) => Number(!!a.also?.length) - Number(!!b.also?.length))
}

const hears = (session: {project: string, also?: string[]}, project: string) => session.project === project || !!session.also?.includes(project)

/** Whether an issue on the board is free to hand out: open in Todo, not a proposal, a parent, someone else's
 * (`forSessions`), blocked (ORR-601) or waiting on the owner. */
const handable = (issue: IssueRecord, parents: Set<string | null>, member?: string) => issue.kind === 'todo' && !issue.proposal && !issue.waiting
    && (member ? issue.assignee?.toLowerCase() === member : forSessions(issue)) && !isBlocked(issue) && !parents.has(issue.id)

/** What the issues in `project` that just changed did to what depends on them (ORR-601). One done frees each issue
 * waiting on it whose other blockers are done too; one with a link dropped may be free itself. Each freed is told
 * (`issue.unblocked`), and handed out when it's in Todo and free to hand out with no focus on its way: to the session
 * that last worked the blocker while that one listens and has nothing in progress, else to an idle session out of
 * work, one each. One canceled asks the owner on each open issue waiting on it; one reopened tells the session
 * working on one. Says how many were handed out. */
export async function handUnblocked(project: string, issues: Map<string, {from?: string, to?: string, links?: true}>): Promise<number> {
    const store = useStore()
    const kinds = new Map((await store.statuses()).map(s => [s.id, s.kind]))
    const kindOf = (status?: string) => status ? kinds.get(status) : undefined
    const freed = new Map<string, {project: string, id: string, blocker?: {project: string, id: string}}>()
    for (const [subject, change] of issues) {
        if (change.links) freed.set(`${project} ${subject}`, {project, id: subject})
        const [from, to] = [kindOf(change.from), kindOf(change.to)]
        if (!to || from === to) continue
        const dependents = await store.dependentsOf(project, subject)
        for (const dependent of dependents) {
            const ref = linkRef(dependent.project, project, subject)
            if (to === 'done') freed.set(`${dependent.project} ${dependent.id}`, {...dependent, blocker: {project, id: subject}})
            else if (to === 'canceled' || from === 'done') {
                const row = await store.issue(dependent.project, dependent.id).catch(() => null)
                if (!row || row.proposal || CLOSED.includes(row.kind as never)) continue
                if (to === 'canceled') {
                    await store.systemAsk(dependent.project, dependent.id, `${ref}, which this depends on, was canceled, so this stays blocked. Drop the link and go ahead, or cancel this too?`, 'issue.blocker_canceled', 'decision')
                } else if (row.kind === 'started') {
                    await store.systemComment(dependent.project, dependent.id, `${ref}, which this depends on, was reopened. Carry on if this still holds, or say here what needs to change.`, 'issue.blocker_reopened')
                }
            }
        }
    }
    let sent = 0
    const owner = {name: (await store.ownerOf()).name, owner: true}
    const given = new Set<string>()
    for (const {project: on, id, blocker} of freed.values()) {
        const board = await store.listIssues(on)
        const issue = board.find(i => i.id === id)
        if (!issue || isBlocked(issue) || issue.proposal || CLOSED.includes(issue.kind as never)) continue
        // Freed by a dropped link only if it waited on something: one never blocked has nothing to announce.
        if (!blocker && !issues.get(id)?.links) continue
        await store.systemEvent(on, id, 'issue.unblocked')
        if (!handable(issue, new Set(board.map(i => i.parent))) || await store.focusOnItsWay(on, id)) continue
        // A follow-up under an issue another session is on goes to that session (ORR-613), busy or not: it's its to start.
        const held = (await store.heldAbove(on, id))?.holder
        if (held) {
            await store.focus(on, id, {note: `${UNBLOCKED_NOTE} ${(issue.depends_on ?? []).join(', ')}.`, session: held}, owner)
            sent++
            continue
        }
        const worker = blocker ? await store.workerOf(blocker.project, blocker.id) : null
        const finisher = worker ? listSessions().find(s => s.id === worker || sessionIds(s.id).includes(worker)) : undefined
        let session = finisher && finisher.listening && hears(finisher, on) && !chatSession(finisher.id) && !untrustedSession(finisher.id)
            && !given.has(finisher.id) && !await store.busy(on, sessionIds(finisher.id)) ? finisher : undefined
        session ??= (await idleSessions(on)).find(s => !given.has(s.id))
        if (!session) continue
        given.add(session.id)
        await store.focus(on, id, {note: `${UNBLOCKED_NOTE} ${(issue.depends_on ?? []).join(', ')}.`, session: currentId(session.id)}, owner)
        sent++
    }
    return sent
}

/** Hands the issues the owner moved into Todo to idle sessions: those still in a todo-kind status (and not moved there
 * from one), not proposals, parents, assigned to someone (`forSessions`), blocked by an issue not done yet (ORR-601) or waiting on the owner, and with no focus already on its way (Focus on
 * this, a P0's push), most urgent first, each to its own idle session out of work, the project's own before one
 * spanning projects. A follow-up under an issue another session is on goes to that session instead (ORR-613). Says
 * how many went. */
export async function handTodo(project: string, issues: Map<string, TodoMove>): Promise<number> {
    const store = useStore()
    const kinds = new Map((await store.statuses()).map(s => [s.id, s.kind]))
    const idle = await idleSessions(project)

    const board = await store.listIssues(project)
    const parents = new Set(board.map(i => i.parent).filter(Boolean))
    const work = []
    for (const issue of board) {
        const move = issues.get(issue.id)
        if (!move || !handable(issue, parents, move.member) || (move.from && kinds.get(move.from) === 'todo')) continue
        if (await store.focusOnItsWay(project, issue.id)) continue
        work.push({issue, by: move.by, member: move.member})
    }
    work.sort((a, b) => (a.issue.priority ? RANK[a.issue.priority] : 4) - (b.issue.priority ? RANK[b.issue.priority] : 4)
        || a.issue.created_at.localeCompare(b.issue.created_at))

    let sent = 0
    const given = new Set<string>()
    for (const {issue, by, member} of work) {
        // A follow-up under an issue another session is on goes to that session (ORR-613), busy or not: any other would
        // be refused its start.
        const held = (await store.heldAbove(project, issue.id))?.holder
        if (held && member && sessionNow(held)?.person !== member) continue
        const free = held ? undefined : idle.find(s => !given.has(s.id) && (!member || s.person === member))
        if (free) given.add(free.id)
        const session = held ?? (free && currentId(free.id))
        if (!session) continue
        await store.focus(project, issue.id, {note: TODO_NOTE, session}, member ? {name: by, owner: false, person: member} : {name: by, owner: true})
        sent++
    }
    return sent
}
