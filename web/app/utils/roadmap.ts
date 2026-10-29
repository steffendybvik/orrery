import type {Chunk, Column, Issue, Kinds, Place, Project, Release, SessionContext} from '#shared/roadmap'
import {CLOSED, PRIORITIES, TINTS, linkRef, madeUpName, open, parseLinkRef, total} from '#shared/roadmap'
import {serverName} from '#shared/connect'

/** A tint's name as its colour; a `#rrggbb` as itself. */
export const colorOf = (color: string) => TINTS[color as keyof typeof TINTS] ?? color

/** Whether a column's kind is closed (done or canceled): out of the open counts. */
export const isClosed = (kind: Place) => CLOSED.includes(kind as never)
/** For the waiting chip: an issue's choices' count while it's a proposal waiting on the owner, which it waits on as a
 * decision (`waiting`), as the bell has it. */
export const pendingProposal = (issue: Issue): {choices: number} | undefined => issue.proposal === 'pending' && issue.waiting === 'decision' ? {choices: issue.choices.length} : undefined

/** A session's state as the page says it. `waiting` is only ever a permission prompt (a Notification hook), so it says so. */
export const SESSION_STATE = {idle: 'idle', working: 'working', waiting: 'permission needed', starting: 'starting'}

/** The projects a session hears: its own and the others its channel serves (`also`). One that hears more than one
 * spans them, and is listed across projects; `all` when that's every project the orrery has. */
export function heardBy(session: {project: string, also?: string[]}, projects: {id: string}[]): {ids: string[], spans: boolean, all: boolean} {
    const ids = [session.project, ...session.also ?? []]
    const spans = ids.length > 1
    return {ids, spans, all: spans && projects.every(p => ids.includes(p.id))}
}

/** The command that starts a session's window again with the channel: its server in the repo's `.mcp.json`, by the
 * name its channel found, else the orrery's as the Connect page names it (`orrery-<environment>`), keeping the window's name unless it was made up. */
export function restartCommand(session: {name: string, project: string, server?: string}, environment: string): string {
    const server = session.server ?? serverName(environment)
    return `${madeUpName(session) ? '' : `ORRERY_SESSION=${session.name} `}claude --dangerously-load-development-channels server:${server}`
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

/** An issue another links to (ORR-601), from its `linkRef` read in `here`: where it is, and the issue when the page has it. */
export function linkedIssue(projects: Project[], here: string, ref: string): {project: string, id: string, issue?: Issue} {
    const {project, id} = parseLinkRef(here, ref)
    return {project, id, issue: findIssue(projects.find(p => p.id === project), id)?.issue}
}

/** The issues one in `here` can depend on, as a picker's options by their `linkRef`: its own project's first, then the
 * others', each with its title. Not `self`. */
export function linkOptions(projects: Project[], here: string, self?: string): {value: string, label: string}[] {
    const ordered = [...projects.filter(p => p.id === here), ...projects.filter(p => p.id !== here)]
    return ordered.flatMap(p => allIssues(p).filter(({issue}) => p.id !== here || issue.id !== self).map(({issue}) => {
        const ref = linkRef(here, p.id, issue.id)
        return {value: ref, label: `${ref} · ${issue.title}`}
    }))
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

/** The changelog's groups, in the order it lists them, and the labels that put an issue in each (ORR-516). An issue
 * goes in the first group one of its labels names, checked in this order (a `bug` labelled `docs` is a fix), and in
 * Changes when none does. */
export const CHANGELOG_GROUPS = [
    {title: 'Features', labels: ['feature', 'feature request', 'feat', 'enhancement']},
    {title: 'Changes', labels: ['improvement', 'perf', 'performance', 'refactor', 'design']},
    {title: 'Fixes', labels: ['bug', 'fix', 'regression']},
    {title: 'Docs', labels: ['docs', 'documentation']},
    {title: 'Internal', labels: ['test', 'tests', 'ci', 'chore', 'maintenance', 'cleanup']},
] as const
const CHECKED = ['Fixes', 'Features', 'Docs', 'Internal', 'Changes'] as const

/** The changelog group an issue goes in, by its labels (any case). */
export function changelogGroup(issue: Pick<Issue, 'labels'>): (typeof CHANGELOG_GROUPS)[number]['title'] {
    const labels = issue.labels.map(l => l.toLowerCase())
    for (const title of CHECKED) {
        if (CHANGELOG_GROUPS.find(g => g.title === title)?.labels.some(l => labels.includes(l))) return title
    }
    return 'Changes'
}

/** A changelog for the release, in Markdown, from its issues' titles: what's done, under Features, Changes, Fixes,
 * Docs and Internal (the empty ones left out), each most urgent first, then by id; then what isn't done yet. */
export function changelogOf(release: Release, chunks: Chunk[], date = release.shipped_on ?? 'unreleased'): string {
    const issues = chunks.flatMap(c => c.tasks)
    const line = (issue: Issue) => `- ${issue.title} (${issue.id})`
    const rank = (issue: Issue) => issue.priority ? PRIORITIES.indexOf(issue.priority) : PRIORITIES.length
    const byUrgency = (a: Issue, b: Issue) => rank(a) - rank(b) || a.id.localeCompare(b.id, undefined, {numeric: true})
    const done = issues.filter(i => i.kind === 'done')
    const open = issues.filter(i => !isClosed(i.kind) && i.kind !== 'proposed')
    const groups = CHANGELOG_GROUPS.flatMap(({title}) => {
        const mine = done.filter(i => changelogGroup(i) === title).sort(byUrgency)
        return mine.length ? ['', `### ${title}`, '', ...mine.map(line)] : []
    })
    return [
        `## ${release.version} (${date})`,
        ...done.length ? groups : ['', '- Nothing done yet'],
        ...open.length ? ['', '<!-- Not done yet -->', ...open.map(line)] : [],
    ].join('\n')
}

/** What a session orrery started was given to go on, in a few words: its presets, and your own words if any. */
/** A text's first line that isn't blank, as a one-line summary of it (a preset's "what it does"). */
export const firstLine = (text: string) => text.split('\n').find(l => l.trim())?.trim() ?? ''
export const contextLabel = (context: SessionContext) => [...context.presets, ...context.instructions ? ['your words'] : []].join(', ')
