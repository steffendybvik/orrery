// The owner moving an issue into Todo, or making one there, hands it to an idle session at once (ORR-515), without
// Focus on this and whether or not sessions pick their next issue (`pick_next`). Each issue goes, as a focus aimed at
// it, to a different idle listening session out of work: one session per issue, and never one that's busy, so a
// working session isn't interrupted. With nobody idle, the issue waits in Todo as before: nothing is queued and no
// session is started. A burst of moves (a bulk move to Todo) is collected first, so the most urgent go out first and
// no session is handed two. An agent's move, a schedule run's or an untrusted session's sends nothing: only the
// owner's signals reach sessions.
//
// An issue whose last blocker closes (ORR-601) is handed out the same way, as if it had just landed in Todo: to the
// session that closed the blocker first, when it has nothing else in progress, so it carries what it learned on;
// else to an idle one. That one goes whoever closed the blocker (an agent, mostly), as the owner put it in Todo, but
// not for a schedule run's or an untrusted session's close.
import type {OrreryEvent} from '#shared/happenings'
import {isBlocked} from '#shared/roadmap'
import type {IssueRecord} from '../store/schema'
import {forSessions} from './pick'

/** How long after the owner's move the issues are handed out, so a burst is one hand-out. */
export const TODO_AFTER = 1500

/** The note the focus goes with. */
export const TODO_NOTE = 'It just landed in Todo.'

/** The note an unblocked issue's focus goes with, after the blockers it waited on. */
export const UNBLOCKED_NOTE = 'What it was waiting on is closed now, so it can start:'

/** The issues the owner moved into (or made in) Todo since the last hand-out, by project: each with the status it
 * left (none when it was made), and who moved it. */
const moved = new Map<string, Map<string, {from?: string, by: string}>>()
/** The issues that moved to some status since the last hand-out, by project: any of them closing may free what
 * depends on it. */
const closing = new Map<string, Set<string>>()
let timer: ReturnType<typeof setTimeout> | undefined

const RANK = {P0: 0, P1: 1, P2: 2, P3: 3}

/** What the store said happened: the owner's move of an issue into some status, or an issue they made, is kept for
 * the next hand-out (whether it's in Todo is read then); anyone's move, for what its closing may unblock. A schedule
 * run's (`cause`) or an untrusted session's isn't, nor is an agent's move into Todo. */
export function heardTodo({event, cause}: {event: OrreryEvent, cause?: unknown}) {
    if (cause || event.untrusted || !event.project || !event.subject) return
    if (event.type === 'issue.status') {
        const issues = closing.get(event.project) ?? new Set()
        closing.set(event.project, issues.add(event.subject))
    }
    if (event.by?.owner && (event.type === 'issue.status' || event.type === 'issue.created')) {
        const issues = moved.get(event.project) ?? new Map()
        issues.set(event.subject, {...event.type === 'issue.status' && event.from ? {from: event.from} : {}, by: event.by.name})
        moved.set(event.project, issues)
    }
    if (!moved.size && !closing.size) return
    timer ??= setTimeout(() => {
        timer = undefined
        const now = [...moved]
        const closed = [...closing]
        moved.clear()
        closing.clear()
        void (async () => {
            for (const [project, issues] of now) {
                await handTodo(project, issues).catch(error => console.error(`[orrery] handing ${project}'s Todo to idle sessions:`, error))
            }
            for (const [project, issues] of closed) {
                await handUnblocked(project, issues).catch(error => console.error(`[orrery] handing out what ${project}'s closed issues unblocked:`, error))
            }
        })()
    }, TODO_AFTER)
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
const handable = (issue: IssueRecord, parents: Set<string | null>) => issue.kind === 'todo' && !issue.proposal && !issue.waiting
    && forSessions(issue) && !isBlocked(issue) && !parents.has(issue.id)

/** Hands out what the issues in `project` that just moved freed (ORR-601): each issue depending on one of them (or on
 * a parent they closed) that is in Todo, free to hand out and blocked no more, with no focus on its way. It goes to
 * the session that last worked the blocker while that one listens and has nothing in progress, else to an idle
 * session out of work, one each. Says how many went. */
export async function handUnblocked(project: string, issues: Set<string>): Promise<number> {
    const store = useStore()
    // A sub-issue closing can close its parent: what depends on the parent may be free too.
    const freed = new Map<string, {project: string, id: string, blocker: {project: string, id: string}}>()
    for (const subject of issues) {
        for (let at: string | null = subject; at;) {
            let row
            try {
                row = await store.issue(project, at)
            } catch {
                break
            }
            for (const dependent of await store.dependentsOf(project, row.id)) {
                freed.set(`${dependent.project} ${dependent.id}`, {...dependent, blocker: {project, id: row.id}})
            }
            at = row.parent
        }
    }
    let sent = 0
    const owner = {name: (await store.ownerOf()).name, owner: true}
    const given = new Set<string>()
    for (const {project: on, id, blocker} of freed.values()) {
        const board = await store.listIssues(on)
        const issue = board.find(i => i.id === id)
        if (!issue || !handable(issue, new Set(board.map(i => i.parent)))) continue
        if (await store.focusOnItsWay(on, id)) continue
        const worker = await store.workerOf(blocker.project, blocker.id)
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
 * from one), not proposals, parents, assigned to someone (`forSessions`), blocked by an issue not closed yet (ORR-601) or waiting on the owner, and with no focus already on its way (Focus on
 * this, a P0's push), most urgent first, each to its own idle session out of work, the project's own before one
 * spanning projects. Says how many went. */
export async function handTodo(project: string, issues: Map<string, {from?: string, by: string}>): Promise<number> {
    const store = useStore()
    const kinds = new Map((await store.statuses()).map(s => [s.id, s.kind]))
    const idle = await idleSessions(project)
    if (!idle.length) return 0

    const board = await store.listIssues(project)
    const parents = new Set(board.map(i => i.parent).filter(Boolean))
    const work = []
    for (const issue of board) {
        const move = issues.get(issue.id)
        if (!move || !handable(issue, parents) || (move.from && kinds.get(move.from) === 'todo')) continue
        if (await store.focusOnItsWay(project, issue.id)) continue
        work.push({issue, by: move.by})
    }
    work.sort((a, b) => (a.issue.priority ? RANK[a.issue.priority] : 4) - (b.issue.priority ? RANK[b.issue.priority] : 4)
        || a.issue.created_at.localeCompare(b.issue.created_at))

    const pairs = work.slice(0, idle.length).map((w, i) => ({...w, session: idle[i]}))
    for (const {issue, by, session} of pairs) {
        if (session) await store.focus(project, issue.id, {note: TODO_NOTE, session: currentId(session.id)}, {name: by, owner: true})
    }
    return pairs.length
}
