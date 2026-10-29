// The owner moving an issue into Todo, or making one there, hands it to an idle session at once (ORR-515), without
// Focus on this and whether or not sessions pick their next issue (`pick_next`). Each issue goes, as a focus aimed at
// it, to a different idle listening session out of work: one session per issue, and never one that's busy, so a
// working session isn't interrupted. With nobody idle, the issue waits in Todo as before: nothing is queued and no
// session is started. A burst of moves (a bulk move to Todo) is collected first, so the most urgent go out first and
// no session is handed two. An agent's move, a schedule run's or an untrusted session's sends nothing: only the
// owner's signals reach sessions.
import type {OrreryEvent} from '#shared/happenings'
import {forSessions} from './pick'

/** How long after the owner's move the issues are handed out, so a burst is one hand-out. */
export const TODO_AFTER = 1500

/** The note the focus goes with. */
export const TODO_NOTE = 'It just landed in Todo.'

/** The issues the owner moved into (or made in) Todo since the last hand-out, by project: each with the status it
 * left (none when it was made), and who moved it. */
const moved = new Map<string, Map<string, {from?: string, by: string}>>()
let timer: ReturnType<typeof setTimeout> | undefined

const RANK = {P0: 0, P1: 1, P2: 2, P3: 3}

/** What the store said happened: the owner's move of an issue into some status, or an issue they made, is kept for
 * the next hand-out (whether it's in Todo is read then). A schedule run's (`cause`), an agent's or an untrusted
 * session's isn't. */
export function heardTodo({event, cause}: {event: OrreryEvent, cause?: unknown}) {
    if (cause || event.untrusted || !event.by?.owner || !event.project || !event.subject) return
    if (event.type !== 'issue.status' && event.type !== 'issue.created') return
    const issues = moved.get(event.project) ?? new Map()
    issues.set(event.subject, {...event.type === 'issue.status' && event.from ? {from: event.from} : {}, by: event.by.name})
    moved.set(event.project, issues)
    timer ??= setTimeout(() => {
        timer = undefined
        const now = [...moved]
        moved.clear()
        for (const [project, issues] of now) {
            handTodo(project, issues).catch(error => console.error(`[orrery] handing ${project}'s Todo to idle sessions:`, error))
        }
    }, TODO_AFTER)
}

/** Hands the issues the owner moved into Todo to idle sessions: those still in a todo-kind status (and not moved there
 * from one), not proposals, parents, the owner's or waiting on them, and with no focus already on its way (Focus on
 * this, a P0's push), most urgent first, each to its own idle session out of work, the project's own before one
 * spanning projects. Says how many went. */
export async function handTodo(project: string, issues: Map<string, {from?: string, by: string}>): Promise<number> {
    const store = useStore()
    const kinds = new Map((await store.statuses()).map(s => [s.id, s.kind]))
    const idle: ReturnType<typeof listSessions> = []
    for (const session of listSessions().filter(s => s.listening && s.state === 'idle' && (s.project === project || s.also?.includes(project)))) {
        if (chatSession(session.id) || untrustedSession(session.id)) continue
        const ids = sessionIds(session.id)
        if (await store.busy(project, ids)) continue
        idle.push(session)
    }
    if (!idle.length) return 0
    idle.sort((a, b) => Number(!!a.also?.length) - Number(!!b.also?.length))

    const board = await store.listIssues(project)
    const parents = new Set(board.map(i => i.parent).filter(Boolean))
    const work = []
    for (const issue of board) {
        const move = issues.get(issue.id)
        if (!move || issue.kind !== 'todo' || (move.from && kinds.get(move.from) === 'todo')) continue
        if (issue.proposal || issue.waiting || !forSessions(issue) || parents.has(issue.id)) continue
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
