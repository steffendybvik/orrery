import type {Chunk, Column, Counts, Issue, Project} from '#shared/roadmap'
import {total} from '#shared/roadmap'

/** How each column looks: its name, its colour as text, and as a fill. */
export const COLUMN_STYLE: Record<Column, {label: string, text: string, fill: string}> = {
    doing: {label: 'Doing', text: 'text-accent-600 dark:text-accent-400', fill: 'bg-accent-500'},
    now: {label: 'Now', text: 'text-sky-600 dark:text-sky-400', fill: 'bg-sky-500'},
    next: {label: 'Next', text: 'text-violet-600 dark:text-violet-400', fill: 'bg-violet-500'},
    later: {label: 'Later', text: 'text-zinc-500 dark:text-zinc-400', fill: 'bg-zinc-400'},
    backlog: {label: 'Backlog', text: 'text-zinc-400 dark:text-zinc-500', fill: 'bg-zinc-300 dark:bg-zinc-600'},
    proposed: {label: 'Proposed', text: 'text-amber-600 dark:text-amber-400', fill: 'bg-amber-400'},
    done: {label: 'Done', text: 'text-emerald-600 dark:text-emerald-400', fill: 'bg-emerald-500'},
}

export const PRIORITY_LABEL: Record<string, string> = {P0: 'Urgent', P1: 'High', P2: 'Medium', P3: 'Low', none: 'No priority'}

/** The columns an issue can be put in, in board order. */
export const PLACES: Column[] = ['proposed', 'backlog', 'later', 'next', 'now', 'doing', 'done']

/** Putting an issue in a column, as its own status and plan. Into Proposed makes it a proposal; a
 * proposal put anywhere else is committed. */
export function columnPatch(column: Column, proposal?: string): Record<string, unknown> {
    if (column === 'proposed') return {proposal: 'pending'}
    const body = column === 'done' || column === 'doing' ? {status: column} : {status: 'todo', plan: column === 'backlog' ? null : column}
    return proposal ? {...body, proposal: null} : body
}

/** Open issues assigned to `owner` anywhere in the project, sub-issues included; the proposals waiting
 * on them first. */
export function myIssues(project: Project, owner: string | null) {
    if (!owner) return []
    return allIssues(project)
        .filter(({issue}) => issue.assignee?.toLowerCase() === owner.toLowerCase() && issue.column !== 'done')
        .sort((a, b) => Number(b.issue.column === 'proposed') - Number(a.issue.column === 'proposed'))
}

/** Open urgent (P0) issues anywhere in the project, sub-issues included. */
export function urgentIssues(project: Project) {
    return allIssues(project).filter(({issue}) => issue.priority === 'P0' && issue.column !== 'done')
}

export function progress(counts: Counts) {
    const all = total(counts)
    return {done: counts.done, total: all, share: all ? counts.done / all : 0}
}

export interface Found {
    issue: Issue
    chunk: Chunk
    /** From the top-level issue down to its parent. */
    parents: Issue[]
}

/** The issue with this id, or one it had before. */
export function findIssue(project: Project | undefined, id: string): Found | null {
    if (!project) return null
    const search = (issues: Issue[], chunk: Chunk, parents: Issue[]): Found | null => {
        for (const issue of issues) {
            if (issue.id === id || issue.aliases.includes(id)) return {issue, chunk, parents}
            const found = search(issue.tasks, chunk, [...parents, issue])
            if (found) return found
        }
        return null
    }
    for (const chunk of project.board.chunks) {
        const found = search(chunk.tasks, chunk, [])
        if (found) return found
    }
    return null
}

/** Every issue in the board, sub-issues after their parent. */
export function allIssues(project: Project): {issue: Issue, chunk: Chunk, depth: number}[] {
    const out: {issue: Issue, chunk: Chunk, depth: number}[] = []
    const walk = (issues: Issue[], chunk: Chunk, depth: number) => issues.forEach(issue => {
        out.push({issue, chunk, depth})
        walk(issue.tasks, chunk, depth + 1)
    })
    project.board.chunks.forEach(chunk => walk(chunk.tasks, chunk, 0))
    return out
}

/** The issues that match, kept with the parents on the way to them. */
export function filterTree(issues: Issue[], matches: (issue: Issue) => boolean): Issue[] {
    return issues.flatMap(issue => {
        const tasks = filterTree(issue.tasks, matches)
        return matches(issue) || tasks.length ? [{...issue, tasks}] : []
    })
}

/** "just now", "5m", "3h", "2d", else the date. */
export function ago(iso: string): string {
    const seconds = (Date.now() - new Date(iso).getTime()) / 1000
    if (!Number.isFinite(seconds)) return ''
    if (seconds < 45) return 'just now'
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
    if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
    if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`
    return new Date(iso).toLocaleDateString(undefined, {day: 'numeric', month: 'short'})
}

export type Section = 'issues' | 'roadmap' | 'docs' | 'schedules' | 'settings'

/** A project's pages, as the sidebar and the tabs show them; `path` marks the one on screen, and
 * `schedules` is how many it has. */
export function sectionsOf(project: Project, path: string, schedules = 0) {
    const base = `/p/${project.id}`
    const on = path.startsWith(`${base}/roadmap`) ? 'roadmap' : path.startsWith(`${base}/docs`) ? 'docs' : path.startsWith(`${base}/schedules`) ? 'schedules'
        : path.startsWith(`${base}/settings`) ? 'settings' : path === base || path.startsWith(`${base}/issues`) ? 'issues' : null
    return [
        {id: 'issues' as Section, label: 'Issues', to: base, count: total(project.board.counts) - project.board.counts.done, active: on === 'issues'},
        {id: 'roadmap' as Section, label: 'Roadmap', to: `${base}/roadmap`, count: project.board.chunks.filter(c => c.id).length, active: on === 'roadmap'},
        {id: 'docs' as Section, label: 'Docs', to: `${base}/docs`, count: project.docs.length, active: on === 'docs'},
        {id: 'schedules' as Section, label: 'Schedules', to: `${base}/schedules`, count: schedules, active: on === 'schedules'},
        {id: 'settings' as Section, label: 'Settings', to: `${base}/settings`, count: 0, active: on === 'settings'},
    ]
}

/** A chunk's page; the issues in no chunk are at `none`. */
export const chunkPath = (project: string, chunk: string) => `/p/${encodeURIComponent(project)}/roadmap/${chunk ? encodeURIComponent(chunk) : 'none'}`
