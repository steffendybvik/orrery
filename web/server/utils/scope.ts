import type {Issue, Signal} from '#shared/roadmap'
import {CLOSED} from '#shared/roadmap'
import type {Store} from './store'

/** What a chunk focus (or one on the whole project, a release, statuses) asks a session to work through, as
 * it stands now: the chunk, its title as told, and its matching issues, most urgent first. Asked again later,
 * it's what's left of the run: issues finished since have dropped out. */
export async function scopeOf(store: Store, project: string, signal: Signal) {
    // `none`: the issues in no chunk, which the board keeps as a chunk without an id; `all`: the whole project's.
    const board = signal.chunk === 'none' || signal.chunk === 'all' ? (await store.project(project)).board : undefined
    const chunk = signal.chunk === 'all'
        ? {title: 'every chunk', column: '', priority: undefined as Issue['priority'], tasks: board!.chunks.flatMap(c => c.tasks)}
        : signal.chunk === 'none'
            ? board!.chunks.find(c => !c.id) ?? {title: 'No chunk', column: 'done', priority: undefined, tasks: []}
            : await store.chunk(project, signal.chunk!)
    // With a release, the issues set for it, at any depth (a sub-issue's when its parent isn't).
    const tasks: Issue[] = []
    const pick = (issues: Issue[]) => issues.forEach(t => t.release === signal.release ? tasks.push(t) : pick(t.tasks))
    if (signal.release) pick(chunk.tasks)
    else tasks.push(...chunk.tasks)
    // Statuses or kinds (`started`), comma-separated: their issues; else every open one.
    const wanted = signal.status?.split(',').map(s => s.trim()).filter(Boolean) ?? []
    const fits = (t: {column: string, kind: string}) => wanted.length
        ? wanted.some(s => t.column === s || t.kind === s)
        : t.kind !== 'proposed' && !CLOSED.includes(t.kind as never)
    const open = tasks.filter(fits).sort((a, b) => (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9'))
    const title = signal.release ? `${chunk.title}, release ${signal.release}` : chunk.title
    return {chunk, title, wanted, open}
}
