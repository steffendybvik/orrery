// A focus, a chunk's or a schedule's message aimed at no session goes to one session, not every one: the session
// already on its issue (made its target as it's sent), else a listening session that's idle when it comes, else the
// next one to go idle. The project's own sessions come first: one that spans several projects (its channel hears
// others too) takes it only while none of them is free. Aimed at `*`, it goes to every session, as all of them used to. Each such signal is taken by
// the first session free to, here in memory (Orrery is one process), so two streams can't both send it on.
import type {Signal} from '#shared/roadmap'

/** The target that sends a signal to every session on the project. */
export const EVERY = '*'

/** Whether the signal goes to one session Orrery picks. A comment has its own way: the session on its issue. */
export function pooled(signal: Signal): boolean {
    return !signal.target && signal.kind !== 'comment'
}

/** Whether the signal is for every session, or for this one (by any id it has had). */
export function aimedAt(signal: Signal, session: string | undefined): boolean {
    // A session reading what others wrote (an untrusted schedule's) hears only what's for it.
    if (session && untrustedSession(session)) return !!signal.target && currentId(signal.target) === currentId(session)
    return !signal.target || signal.target === EVERY || !!session && currentId(signal.target) === currentId(session)
}

/** Who took each pooled signal, by its id: the session, on the project whose stream sent it. */
const taken = new Map<number, {session: string, project: string}>()

/** The session takes the pooled signal if no session has and it's free for it: idle, or with no hooks to say
 * (a stream with no session, such as the Monitor tool's, takes it as it comes), and, spanning projects, with none of
 * the project's own sessions listening and idle, which take it instead. Says whether it's the session's. */
export function take(signal: Signal, project: string, session: string | undefined): boolean {
    if (signal.delivered_to.length) return false
    const had = taken.get(signal.id)
    if (had) return !!session && currentId(had.session) === currentId(session)
    const now = session ? sessionNow(session) : undefined
    if (session && now?.state !== 'idle') return false
    if (now?.also?.length && listSessions(project).some(s => s.project === project && !s.also?.length && s.listening && s.state === 'idle')) return false
    taken.set(signal.id, {session: session ?? '', project})
    // Only the latest matter: an old one was delivered long since, or nobody took it up.
    if (taken.size > 500) for (const oldest of taken.keys()) {
        taken.delete(oldest)
        break
    }
    return true
}

/** The session's stream on the project closed: what it took and didn't hand on is free for another session. */
export function handBack(project: string, session: string) {
    for (const [id, by] of taken) if (by.project === project && currentId(by.session) === currentId(session)) taken.delete(id)
}
