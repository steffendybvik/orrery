import type {Issue, Signal} from '#shared/roadmap'
import {CLOSED, byPriority, isBlocked} from '#shared/roadmap'
import type {Store} from './store'
import {known} from '#shared/known'

/** What a milestone focus (or one on the whole project, a release, statuses) asks a session to work through, as
 * it stands now: the milestone, its title as told, and its matching issues, most urgent first, without those blocked by
 * another issue (`held`). Asked again later, it's what's left of the run: issues finished since have dropped out,
 * and ones whose blockers are done since have joined. */
export async function scopeOf(store: Store, project: string, signal: Signal) {
    // `none`: the issues in no milestone, which the board keeps as a milestone without an id; `all`: the whole project's.
    const board = async () => (await store.project(project)).board
    const milestone = signal.milestone === 'all'
        ? {title: 'every milestone', column: '', priority: undefined as Issue['priority'], tasks: (await board()).milestones.flatMap(c => c.tasks)}
        : signal.milestone === 'none'
            ? (await board()).milestones.find(c => !c.id) ?? {title: 'No milestone', column: 'done', priority: undefined, tasks: []}
            : await store.milestone(project, known(signal.milestone, 'the milestone a milestone focus is on'))
    // With a release, the issues set for it, at any depth (a sub-issue's when its parent isn't).
    const tasks: Issue[] = []
    const pick = (issues: Issue[]) => issues.forEach(t => t.release === signal.release ? tasks.push(t) : pick(t.tasks))
    if (signal.release) pick(milestone.tasks)
    else tasks.push(...milestone.tasks)
    // Statuses or kinds (`started`), comma-separated: their issues; else every open one.
    const wanted = signal.status?.split(',').map(s => s.trim()).filter(Boolean) ?? []
    const fits = (t: {column: string, kind: string}) => wanted.length
        ? wanted.some(s => t.column === s || t.kind === s)
        : t.kind !== 'proposed' && !CLOSED.includes(t.kind as never)
    // One blocked by an issue not done yet waits (`held`, ORR-601): it joins once its blockers are done.
    const open = tasks.filter(t => fits(t) && !isBlocked(t)).sort(byPriority)
    const held = tasks.filter(t => fits(t) && isBlocked(t)).sort(byPriority)
    const title = signal.release ? `${milestone.title}, release ${signal.release}` : milestone.title
    return {milestone, title, wanted, open, held}
}
