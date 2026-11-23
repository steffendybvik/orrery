// Every issue in Todo gets acted on, urgent or not (ORR-1399): urgency only sets the order. An idle session out of work
// picks from Todo already (pick.ts), and the owner's move into Todo goes to an idle session at once (todo-focus.ts),
// but with every session busy, or none running, a Todo issue below P0 waited until one happened to come free, as only
// a P0's push starts a session (launches.ts, `considerLaunch`). So orrery also starts a session for Todo work nobody
// is free to take: for each project a launcher serves, the issues a session may start (`pickable`, the pick list's
// rules: not a proposal, a parent, blocked, waiting on the owner, someone else's, or on a board held from picks), most
// urgent first, then oldest, less one for each idle session out of work (it picks one itself) and each launch on its
// way, each get a session of their own, focused on it alone, within the limit the owner gave orrery's sessions
// (`starts`). Not when the owner has `on_signal` off (work alone starts none), nor for an issue with a focus on its
// way, nor again for one it started a session for in the last `RETRY_AFTER` (a session that passed it over, saying why,
// isn't replaced by another that would do the same). Only the owner's work: this orrery's launchers are the owner's
// (ORR-656). It runs on the launches check (every 30 seconds) and right after a Todo hand-out.
import {launcherProjects, pendingOn, startLaunch} from './launches'
import {pickable} from './pick'

/** How long before orrery starts a session for the same issue again. */
export const RETRY_AFTER = 60 * 60 * 1000

/** The note on the focus a session started for a Todo issue goes with. */
export const TODO_START_NOTE = "It's in Todo and no session was free to take it, so this one was started for it."

/** When orrery last started a session for each issue, by `<project> <issue>`. */
const startedFor = new Map<string, number>()

let sweeping: Promise<number> | null = null

/** Starts a session for each Todo issue nobody is free to take, across the projects a launcher serves. One sweep at a
 * time, so the timer and a hand-out don't both start one. Says how many it started. */
export function startForTodo(): Promise<number> {
    sweeping ??= sweep().finally(() => {
        sweeping = null
    })
    return sweeping
}

async function sweep(): Promise<number> {
    for (const [key, at] of startedFor) if (Date.now() - at >= RETRY_AFTER) startedFor.delete(key)
    let started = 0
    for (const project of launcherProjects()) {
        started += await startOn(project).catch(error => {
            console.error(`[orrery] starting sessions for ${project}'s Todo:`, error)
            return 0
        })
    }
    return started
}

/** The idle listening sessions hearing `project` that are out of work: each picks its next issue itself. */
async function freeSessions(project: string): Promise<number> {
    const store = useStore()
    let free = 0
    for (const s of listSessions().filter(s => s.listening && s.state === 'idle' && (s.project === project || s.also?.includes(project)))) {
        if (chatSession(s.id) || untrustedSession(s.id) || s.started?.chat || s.started?.untrusted) continue
        if (!await store.engaged(project, sessionIds(s.id))) free++
    }
    return free
}

async function startOn(project: string): Promise<number> {
    const store = useStore()
    const starts = await store.starts(project)
    if (!starts || starts.on_signal === false) return 0
    const owner = (await store.ownerOf()).name
    const todo = []
    for (const issue of await pickable([project], owner)) {
        if (startedFor.has(`${project} ${issue.id}`) || await store.focusOnItsWay(project, issue.id)) continue
        todo.push(issue)
    }
    // Those free now, and those on their way, take the most urgent first.
    const left = todo.slice((await freeSessions(project)) + pendingOn(project))
    let started = 0
    for (const issue of left) {
        try {
            startedFor.set(`${project} ${issue.id}`, Date.now())
            await startLaunch(project, {issue: issue.id, note: TODO_START_NOTE, actor: {name: owner, owner: true}})
            started++
        } catch {
            // No room under the limit, or no launcher after all: tried again at the next check.
            startedFor.delete(`${project} ${issue.id}`)
            break
        }
    }
    return started
}
