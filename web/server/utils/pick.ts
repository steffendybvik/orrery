// A session out of work picks its next issue (ORR-452), with the owner's `pick_next` setting on. Once a listening
// session is idle with nothing in progress, no run with issues left, nothing waiting on the owner and no signal queued,
// it's sent, alone, the issues it may start (Todo, or Backlog once Todo is empty, most urgent first) and starts the one
// it judges best, passing over one it can't do yet with a comment saying why. With nothing on the list, nothing is
// sent: no turn starts, and it stays idle. A session orrery started is picked for once its `/clear` is done (from the
// SessionStart that follows it, when it has no run to resume), as clearing it after would lose what it was handed.
// When the board changes, the idle sessions are tried again (not one due its clear: it picks after the clear), one at
// a time a few seconds apart, so they don't all go for the same issue; the one-session-per-issue lock (`claim` in
// store.ts) turns away a second start anyway.
import type {Issue} from '#shared/roadmap'
import {freezeNote} from '#shared/roadmap'
import type {IssueRecord} from '../store/schema'

/** How many issues a session is handed at most. */
export const PICK_FROM = 10
/** How long after the board changes the idle sessions are tried again, and how far apart. */
export const RECHECK_AFTER = 5000
export const PICK_APART = 5000

/** The note a pick list goes with, which tells it from the owner's own words. */
export const PICK_NOTE = "You're out of work, so pick your next issue from these, most urgent first."

/** What each session was last handed, by its id now: not sent again while it hasn't changed. */
const handed = new Map<string, string>()

const RANK = {P0: 0, P1: 1, P2: 2, P3: 3}
const urgency = (issue: Pick<Issue, 'priority'>) => issue.priority ? RANK[issue.priority] : 4

/** Whether an issue is free for a session to take: nobody's on it, or an agent is (`claude`). One assigned to the
 * owner or to anyone else is theirs. Picking and the Todo hand-out (todo-focus.ts) both go by it. */
export const forSessions = (issue: {assignee?: string | null}) => !issue.assignee || issue.assignee === 'claude'

/** The issues a session hearing `projects` may start: Todo, or Backlog when there's no Todo, most urgent first (then
 * oldest), without proposals not yet approved, ones assigned to someone (`forSessions`), ones waiting on the owner's
 * answer, and parents (their sub-issues are the work). At most PICK_FROM. */
export async function pickable(projects: string[]): Promise<(IssueRecord & {project: string})[]> {
    const store = useStore()
    const open: (IssueRecord & {project: string})[] = []
    for (const project of projects) {
        for (const issue of await store.listIssues(project)) {
            if (issue.proposal || issue.waiting || !forSessions(issue)) continue
            if (issue.kind !== 'todo' && issue.kind !== 'backlog') continue
            open.push({...issue, project})
        }
    }
    const parents = new Set(open.map(i => i.parent).filter(Boolean))
    const work = open.filter(i => !parents.has(i.id))
    const todo = work.filter(i => i.kind === 'todo')
    return (todo.length ? todo : work.filter(i => i.kind === 'backlog'))
        .sort((a, b) => urgency(a) - urgency(b) || a.created_at.localeCompare(b.created_at))
        .slice(0, PICK_FROM)
}

/** The message a session is handed: what to do, then the list, a line each, with a frozen release's note. */
export async function pickMessage(issues: (IssueRecord & {project: string})[]): Promise<string> {
    const store = useStore()
    const notes = new Map<string, string | null>()
    const lines: string[] = []
    for (const issue of issues) {
        let note: string | null = null
        if (issue.release) {
            const key = `${issue.project} ${issue.release}`
            if (!notes.has(key)) notes.set(key, freezeNote((await store.project(issue.project)).releases.find(r => r.version === issue.release)))
            note = notes.get(key) ?? null
        }
        lines.push(`- ${issue.id} (${issue.project}) [${issue.column}${issue.priority ? `, ${issue.priority}` : ''}] ${issue.title}${note ? ` (${note})` : ''}`)
    }
    return `${PICK_NOTE} Read the one you choose and the docs it touches, then start it as you would a focus on it. Pass over one you can't do yet (blocked on another, say), with a comment on it saying why. If another session has it already ("pick another issue"), take the next. If none is one you can do, stop: you'll be handed the list again when the board changes.\n\n${lines.join('\n')}`
}

/** Hands the session the issues it may start, if `pick_next` is on and it's out of work: listening, idle, not a chat
 * or an untrusted schedule's, nothing in progress, no run with issues left, nothing waiting on the owner, no signal
 * queued. Not again while the list is what it was last handed. Says whether it sent one. */
export async function pickNext(project: string, id: string): Promise<boolean> {
    const store = useStore()
    if (!(await store.settings()).pick_next) return false
    const session = sessionNow(id)
    if (!session?.listening || session.state !== 'idle' || untrustedSession(id) || chatSession(id)) return false
    const ids = sessionIds(id)
    if ((await store.workingOn(project, ids)).length || await store.waiting(project, ids)) return false
    const run = runOf(id)
    if (run?.chunk && (await scopeOf(store, run.project, run)).open.length) return false
    const issues = await pickable([session.project, ...session.also ?? []])
    for (const known of handed.keys()) {
        if (!sessionNow(known)) handed.delete(known)
    }
    const list = issues.map(i => `${i.project} ${i.id} ${i.column} ${i.priority ?? ''}`).join('\n')
    if (!issues.length || handed.get(currentId(id)) === list) return false
    handed.set(currentId(id), list)
    await store.messageSession(session.project, currentId(id), await pickMessage(issues), {name: (await store.ownerOf()).name, owner: true})
    return true
}

/** The session went idle: a moment later, if it's still idle and wasn't started by orrery (that one picks after its
 * clear), it's handed the list. */
export function pickWhenIdle(project: string, id: string) {
    const before = sessionNow(id)
    if (!before?.listening || before.state !== 'idle' || before.started) return
    setTimeout(async () => {
        try {
            const now = sessionNow(id)
            if (now?.state !== 'idle' || now.idleAt !== before.idleAt) return
            await pickNext(now.project, id)
        } catch (error) {
            console.error(`[orrery] handing ${id} its next pick:`, error)
        }
    }, CLEAR_AFTER)
}

let rechecking: ReturnType<typeof setTimeout> | undefined

/** The board changed: a moment later, each idle listening session out of work is tried again, a few seconds apart,
 * so the first takes an issue before the next is handed what's left. */
export function recheckIdle() {
    if (rechecking) return
    rechecking = setTimeout(async () => {
        rechecking = undefined
        try {
            if (!(await useStore().settings()).pick_next) return
            // One orrery started that's due its clear picks after it: handed the list first, it would skip the clear.
            for (const session of listSessions().filter(s => s.listening && s.state === 'idle' && !clearPending(s.id))) {
                if (await pickNext(session.project, session.id)) await new Promise(resolve => setTimeout(resolve, PICK_APART))
            }
        } catch (error) {
            console.error('[orrery] handing idle sessions their next pick:', error)
        }
    }, RECHECK_AFTER)
}
