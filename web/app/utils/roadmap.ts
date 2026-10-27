import type {Chunk, Column, Issue, Kinds, Place, Project, Release, SessionContext} from '#shared/roadmap'
import {CLOSED, PRIORITIES, TINTS, open, total} from '#shared/roadmap'
import {serverName} from '#shared/connect'

/** A tint's name as its colour; a `#rrggbb` as itself. */
export const colorOf = (color: string) => TINTS[color as keyof typeof TINTS] ?? color

/** Whether a column's kind is closed (done or canceled): out of the open counts. */
export const isClosed = (kind: Place) => CLOSED.includes(kind as never)

/** A session's state as the page says it. */
export const SESSION_STATE = {idle: 'idle', working: 'working', waiting: 'needs you', starting: 'starting'}

/** The command that starts a session's window again with the channel: its server in the repo's `.mcp.json`, by the
 * name its channel found, else the Orrery's as the Connect page names it (`orrery-<environment>`), keeping the window's name unless it was made up. */
export function restartCommand(session: {name: string, project: string, server?: string}, environment: string): string {
    const server = session.server ?? serverName(environment)
    return `${session.name.startsWith(`${session.project} `) ? '' : `ORRERY_SESSION=${session.name} `}claude --dangerously-load-development-channels server:${server}`
}

export const PRIORITY_LABEL: Record<string, string> = {P0: 'Urgent', P1: 'High', P2: 'Medium', P3: 'Low', none: 'No priority'}

/** The priorities as a `PropertyPicker`'s options, none first. */
export const PRIORITY_OPTIONS = [{value: '', label: 'No priority'}, ...PRIORITIES.map(p => ({value: p, label: `${p} · ${PRIORITY_LABEL[p]}`}))]

/** A project's chunks as a `PropertyPicker`'s options, none first (the chunk of loose issues has no id). */
export const chunkOptions = (chunks: Chunk[]) => [{value: '', label: 'No chunk'}, ...chunks.filter(c => c.id).map(c => ({value: c.id, label: c.title}))]

/** Putting an issue in a column: its status. Into Proposed makes it a proposal; a proposal put anywhere
 * else is committed. */
export function columnPatch(column: Column, proposal?: string): Record<string, unknown> {
    if (column === 'proposed') return {proposal: 'pending'}
    return proposal ? {status: column, proposal: null} : {status: column}
}

/** Open issues assigned to `owner` anywhere in the project, sub-issues included, and every proposal
 * waiting on them whoever it's assigned to; the proposals first. */
export function myIssues(project: Project, owner: string | null) {
    if (!owner) return []
    return allIssues(project)
        .filter(({issue}) => (issue.assignee?.toLowerCase() === owner.toLowerCase() || issue.proposal === 'pending') && !isClosed(issue.kind))
        .sort((a, b) => Number(b.issue.column === 'proposed') - Number(a.issue.column === 'proposed'))
}

/** What the Now page lists: started issues, and urgent or high-priority ones to do. */
export const isNow = (issue: Issue) => issue.kind === 'started' || (issue.kind === 'todo' && (issue.priority === 'P0' || issue.priority === 'P1'))

/** Open urgent (P0) issues anywhere in the project, sub-issues included. */
export function urgentIssues(project: Project) {
    return allIssues(project).filter(({issue}) => issue.priority === 'P0' && !isClosed(issue.kind))
}

/** Done leaves out of the committed ones (canceled ones left out). */
export function progress(kinds: Kinds) {
    const all = total(kinds)
    return {done: kinds.done, total: all, share: all ? kinds.done / all : 0}
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

export type Section = 'issues' | 'roadmap' | 'releases' | 'docs' | 'schedules' | 'sessions' | 'settings'

/** A project's pages, as the sidebar and the tabs show them; `path` marks the one on screen. Its sessions and
 * schedules are on the Sessions and Schedules pages, kept to it. */
export function sectionsOf(project: Project, path: string) {
    const base = `/p/${project.id}`
    const on = path.startsWith(`${base}/roadmap`) ? 'roadmap' : path.startsWith(`${base}/releases`) ? 'releases' : path.startsWith(`${base}/docs`) ? 'docs'
        : path.startsWith(`${base}/settings`) ? 'settings' : path === base || path.startsWith(`${base}/issues`) ? 'issues' : null
    const sections = [
        {id: 'issues' as Section, label: 'Issues', to: base, count: open(project.board.kinds), active: on === 'issues'},
        {id: 'roadmap' as Section, label: 'Roadmap', to: `${base}/roadmap`, count: project.board.chunks.filter(c => c.id).length, active: on === 'roadmap'},
        // Counted: the releases still being prepared.
        {id: 'releases' as Section, label: 'Releases', to: `${base}/releases`, count: project.releases.filter(r => !r.shipped_on).length, active: on === 'releases'},
        {id: 'docs' as Section, label: 'Docs', to: `${base}/docs`, count: project.docs.length, active: on === 'docs'},
        {id: 'settings' as Section, label: 'Settings', to: `${base}/settings`, count: 0, active: on === 'settings'},
    ]
    // Releases only for a project that has them (not every project ships), unless it's the page on screen.
    return sections.filter(s => s.id !== 'releases' || project.release_mode !== 'none' || s.active)
}

/** A release's page. */
export const releasePath = (project: string, version: string) => `/p/${encodeURIComponent(project)}/releases/${encodeURIComponent(version)}`

/** A chunk's page; the issues in no chunk are at `none`. */
export const chunkPath = (project: string, chunk: string) => `/p/${encodeURIComponent(project)}/roadmap/${chunk ? encodeURIComponent(chunk) : 'none'}`

/** The issues set for a release, chunk by chunk as the board has them: a sub-issue set for it on its own
 * comes up from under its parent. Chunks with none of them are left out. */
export function releaseChunks(project: Project, version: string): Chunk[] {
    const pick = (issues: Issue[]): Issue[] => issues.flatMap(issue => issue.release === version ? [issue] : pick(issue.tasks))
    return project.board.chunks.map(c => ({...c, tasks: pick(c.tasks)})).filter(c => c.tasks.length)
}

/** A changelog for the release, in Markdown, from its issues' titles: what's done, then what isn't yet. */
export function changelogOf(release: Release, chunks: Chunk[], date = release.shipped_on ?? 'unreleased'): string {
    const issues = chunks.flatMap(c => c.tasks)
    const line = (issue: Issue) => `- ${issue.title} (${issue.id})`
    const done = issues.filter(i => i.kind === 'done')
    const open = issues.filter(i => !isClosed(i.kind) && i.kind !== 'proposed')
    return [
        `## ${release.version} (${date})`,
        '',
        ...done.length ? done.map(line) : ['- Nothing done yet'],
        ...open.length ? ['', '<!-- Not done yet -->', ...open.map(line)] : [],
    ].join('\n')
}

/** What a session Orrery started was given to go on, in a few words: its presets, and your own words if any. */
/** A text's first line that isn't blank, as a one-line summary of it (a preset's "what it does"). */
export const firstLine = (text: string) => text.split('\n').find(l => l.trim())?.trim() ?? ''
export const contextLabel = (context: SessionContext) => [...context.presets, ...context.instructions ? ['your words'] : []].join(', ')
