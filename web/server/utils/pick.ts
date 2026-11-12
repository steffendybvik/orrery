// A session out of work picks its next issue (ORR-452), always: there's no setting (ORR-1043). Once a listening
// session is idle with nothing in progress but parked issues (waiting on the owner, or in review: ORR-1032), no run with issues left, nothing waiting on the owner and no signal queued,
// it's sent, alone, the issues it may start (Todo, most urgent first; Backlog is the owner's to point at, ORR-759) and starts the one
// it judges best, passing over one it can't do yet with a comment saying why. With nothing on the list, nothing is
// sent: no turn starts, and it stays idle. A session orrery started is picked for once its `/clear` is done (from the
// SessionStart that follows it, when it has no run to resume), as clearing it after would lose what it was handed.
// When the board changes, the idle sessions are tried again (not one due its clear, even one that became due while the
// others were tried: it picks after the clear), one at a time a few seconds apart, so they don't all go for the same issue; the one-session-per-issue lock (`claim` in
// store.ts) turns away a second start anyway. A session can also ask for the list itself, with the channel's `next`
// (ORR-521): the same list and message, by the same rules (`stillBusy`), whenever it asks.
import type {Issue} from '#shared/roadmap'
import {freezeNote, isBlocked} from '#shared/roadmap'
import type {IssueRecord} from '../store/schema'

/** How many issues a session is handed at most. */
const PICK_FROM = 10
/** How long after the board changes the idle sessions are tried again, and how far apart. */
export const RECHECK_AFTER = 5000
export const PICK_APART = 5000

/** The note a pick list goes with, which tells it from the owner's own words. */
export const PICK_NOTE = "You're out of work, so pick your next issue from these, most urgent first."

/** What each session was last handed, by its id now: not sent again while it hasn't changed. */
const handed = new Map<string, string>()

const RANK = {P0: 0, P1: 1, P2: 2, P3: 3}
const urgency = (issue: Pick<Issue, 'priority'>) => issue.priority ? RANK[issue.priority] : 4

/** Whether an issue is free for a session to take: nobody's on it, or an agent is (`claude`, in any case, as the
 * board shows it). One assigned to the owner or to anyone else is theirs. Picking and the Todo hand-out
 * (todo-focus.ts) both go by it. */
export const forSessions = (issue: {assignee?: string | null}) => !issue.assignee || issue.assignee.toLowerCase() === 'claude'

/** Who may be handed an issue (ORR-656): `null` nobody; `{}` any session, as with one person; else the sessions of
 * `{person}`, the person whose work it is. The owner's own is theirs to work, as `forSessions` says, and a member's goes
 * to their agents. `member`: only they may be handed it, as it's their hand-out. */
export async function handedTo(project: string, issue: {assignee?: string | null}, member?: string): Promise<{person?: string} | null> {
    const store = useStore()
    const whose = await store.whoseWork(project, issue.assignee)
    if (whose === undefined) return forSessions(issue) ? {} : null
    if (whose === null || member && whose !== member) return null
    return whose === (await store.ownerOf()).name && !forSessions(issue) ? null : {person: whose}
}

/** The issues a session hearing `projects` may start: Todo, most urgent first (then
 * oldest), without proposals not yet approved, ones assigned to someone (`forSessions`), ones waiting on the owner's
 * answer, ones blocked by an issue not done yet (ORR-601), sub-issues of one another session is on (ORR-613), and parents
 * (their sub-issues are the work). At most PICK_FROM. */
async function pickable(projects: string[], person?: string): Promise<(IssueRecord & {project: string})[]> {
    const store = useStore()
    const open: (IssueRecord & {project: string})[] = []
    for (const project of projects) {
        for (const issue of await store.listIssues(project)) {
            if (issue.proposal || issue.waiting || isBlocked(issue)) continue
            const to = await handedTo(project, issue)
            if (!to || to.person && to.person !== person) continue
            if (issue.kind !== 'todo' && issue.kind !== 'backlog') continue
            // A follow-up under an issue a session is on is that session's to start (ORR-611), and the one picking isn't it: it's out of work.
            if (issue.parent && await store.heldAbove(project, issue.id)) continue
            open.push({...issue, project})
        }
    }
    const parents = new Set(open.map(i => i.parent).filter(Boolean))
    const work = open.filter(i => !parents.has(i.id))
    return work.filter(i => i.kind === 'todo')
        .sort((a, b) => urgency(a) - urgency(b) || a.created_at.localeCompare(b.created_at))
        .slice(0, PICK_FROM)
}

/** The message a session is handed: what to do, then the list, a line each, with a frozen release's note. */
async function pickMessage(issues: (IssueRecord & {project: string})[]): Promise<string> {
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

/** Why the session isn't out of work, by the rules the push (`pickNext`) and the pull (`nextFor`, ORR-521) share: it's
 * a chat or an untrusted schedule's, it has an issue in progress that isn't parked (waiting on the owner, or in review:
 * ORR-1032) or something waiting on the owner, or a run with issues left. Nothing when it's out of work. */
async function stillBusy(project: string, id: string): Promise<string | null> {
    if (chatSession(id)) return "The chat doesn't take up work: it files and delegates it."
    if (untrustedSession(id)) return "An untrusted schedule's session doesn't take up work: it raises proposals."
    const store = useStore()
    if (await store.engaged(project, sessionIds(id))) return 'You still have work: an issue in progress that isn\'t parked, or a question waiting on the owner. Finish or park it first.'
    const run = runOf(id)
    if (run?.milestone) {
        const {open} = await scopeOf(store, run.project, run)
        if (open.length) return `Your run has issues left (${open.map(i => i.id).join(', ')}): carry on with those.`
    }
    return null
}

/** What `handed` keeps of a list, to tell it hasn't changed. */
const listed = (issues: (IssueRecord & {project: string})[]) => issues.map(i => `${i.project} ${i.id} ${i.column} ${i.priority ?? ''}`).join('\n')

/** Hands the session the issues it may start, if it's out of work (`stillBusy`), listening, idle and not due its clear
 * (handed the list first, it would skip the clear). Not again while the list is what it was last handed, by this or
 * by its own ask (`nextFor`). Says whether it sent one. */
export async function pickNext(project: string, id: string): Promise<boolean> {
    const store = useStore()
    const session = sessionNow(id)
    if (!session?.listening || session.state !== 'idle' || clearPending(id)) return false
    if (await stillBusy(project, id)) return false
    const issues = await pickable([session.project, ...session.also ?? []], session.person)
    for (const known of handed.keys()) {
        if (!sessionNow(known)) handed.delete(known)
    }
    const list = listed(issues)
    if (!issues.length || handed.get(currentId(id)) === list) return false
    handed.set(currentId(id), list)
    await store.messageSession(session.project, currentId(id), await pickMessage(issues), {name: (await store.ownerOf()).name, owner: true})
    return true
}

/** A session asking for its next issue itself (ORR-521, the channel's `next`): what the push would hand it, now, with
 * no rules of its own. `issues` the list, `text` the message that goes with it (`pickMessage`), or why there's none.
 * The list counts as handed, so the push doesn't send it again unchanged. Nothing for a session orrery doesn't know. */
export async function nextFor(id: string): Promise<{issues: {id: string, project: string, title: string, column?: string, priority: string | null}[], text: string} | undefined> {
    const session = sessionNow(id)
    if (!session) return undefined
    const busy = await stillBusy(session.project, id)
    if (busy) return {issues: [], text: busy}
    const issues = await pickable([session.project, ...session.also ?? []], session.person)
    if (!issues.length) return {issues: [], text: "Nothing to pick: no Todo issue is free for you. Stop here: you'll be handed the list when the board changes."}
    handed.set(currentId(id), listed(issues))
    return {issues: issues.map(i => ({id: i.id, project: i.project, title: i.title, column: i.column, priority: i.priority ?? null})), text: await pickMessage(issues)}
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
            // Each is checked as its turn comes (`pickNext`): one can go busy, or due its clear, while the one before waits.
            for (const session of listSessions().filter(s => s.listening && s.state === 'idle')) {
                if (await pickNext(session.project, session.id)) await new Promise(resolve => setTimeout(resolve, PICK_APART))
            }
        } catch (error) {
            console.error('[orrery] handing idle sessions their next pick:', error)
        }
    }, RECHECK_AFTER)
}
