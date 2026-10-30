// What each running session has been given as it works (ORR-549): the signals its stream sent it and what its tool
// calls answered, its latest `CONTEXT_KEPT` of them, for the Context page to show beside what it's given as it connects.
// Held in memory only: it's for looking at now, and a restart starts it afresh.
import type {ContextEntry} from '#shared/context'
import {CONTEXT_KEPT, CONTEXT_TEXT_KEPT} from '#shared/context'

/** Sessions whose entries are kept, the least recently given something dropped first. */
const SESSIONS_KEPT = 50
/** Tools whose answers are kept by their size alone: an egress answer is what an outside service sent back, which may
 * hold a token or someone's data, a GitHub read may be a private repo's (ORR-748), and anything that reaches orrery can
 * read this log (ORR-573). */
const SIZE_ONLY = new Set(['egress', 'github_issues', 'github_pulls'])
const logs = new Map<string, ContextEntry[]>()
/** When each session's context was last cleared or compacted, by the id it went by then (ORR-575). */
const cuts = new Map<string, string>()

/** Keeps that `session` was given `text`, as a signal or a tool's answer (`title`, its name). */
export function noteContext(session: string, kind: ContextEntry['kind'], title: string, text: string) {
    const id = currentId(session)
    const log = logs.get(id) ?? []
    logs.delete(id)
    const kept = kind === 'tool' && SIZE_ONLY.has(title) ? '' : text.slice(0, CONTEXT_TEXT_KEPT)
    logs.set(id, [{at: new Date().toISOString(), kind, title, text: kept, chars: text.length, tokens: Math.ceil(text.length / 4)},
        ...log].slice(0, CONTEXT_KEPT))
    const oldest = logs.keys().next().value
    if (logs.size > SESSIONS_KEPT && oldest) {
        logs.delete(oldest)
        cuts.delete(oldest)
    }
}

/** Keeps that `session` just had its context cleared (`/clear`) or compacted: what it was given before is gone from it. */
export function noteContextCut(session: string) {
    cuts.set(currentId(session), new Date().toISOString())
}

/** What `session` has been given so far, newest first, under any id it has gone by: what came before its last clear or
 * compaction marked `before`, as it's no longer in its context. */
export function contextSoFar(session: string): ContextEntry[] {
    const ids = sessionIds(session)
    const cut = ids.map(id => cuts.get(id) ?? '').toSorted().at(-1)
    return ids.flatMap(id => logs.get(id) ?? []).toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, CONTEXT_KEPT)
        .map(e => cut && e.at < cut ? {...e, before: true} : e)
}
