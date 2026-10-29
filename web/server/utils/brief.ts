// What a session's hook hands Claude Code as a session starts (POST /api/sessions on `SessionStart`): after a `/clear`, a
// compaction or a resume, the issues it has in progress and what's left of the chunk or scope it was working through, so
// the work carries on; and for a session orrery started with context, that context, every time.
import {contextBlock, launchContext} from './launches'
import {runOf} from './clearing'
import {issueLine} from './roadmap'
import {scopeOf} from './scope'
import {sessionIds} from './sessions'
import type {Store} from './store'

/** What happened to the session, by `source`, for the brief's first line. */
const RESUMED: Record<string, string> = {
    clear: "this window's context was just cleared",
    compact: "this window's context was just compacted",
    resume: 'this session was just resumed',
}

/** The brief for session `session` starting on `project` from `source`, with `launch` the one orrery started it for;
 * none when it has nothing to carry on with and no context. `api` is the project's address as the session reaches it. */
export async function sessionBrief(store: Store, {project, session, source, launch, api}: {
    project: string, session: string, source?: string, launch?: string, api: string,
}): Promise<string | undefined> {
    const happened = source && Object.hasOwn(RESUMED, source) ? RESUMED[source] : undefined
    const work = happened ? await workBrief(store, project, session, happened, api).catch(() => undefined) : undefined
    const context = launch ? launchContext(project, launch) : undefined
    if (!work && !context) return undefined
    return [work, context && contextBlock(context)].filter(Boolean).join('\n\n')
}

/** What the session has in progress, told to its fresh context, and what's left of the chunk or scope it was
 * working through; none when it has neither. */
async function workBrief(store: Store, project: string, session: string, happened: string, api: string): Promise<string | undefined> {
    const issues = await store.workingOn(project, sessionIds(session))
    const run = runOf(session)
    const scope = run && run.project === project ? await scopeOf(store, project, run).catch(() => undefined) : undefined
    const left = scope?.open.filter(t => !issues.some(i => i.id === t.id)) ?? []
    if (!issues.length && !left.length) return undefined
    const statuses = await store.statuses()
    const said = (body: string) => body.replace(/\s+/g, ' ').trim().slice(0, 300)
    return [
        `orrery: ${happened}.`,
        ...issues.length ? [
            `It was working on these issues in project "${project}"; carry on with them:`,
            ...issues.map(issue => [
                issueLine(issue, statuses),
                issue.last ? `  last comment, by ${issue.last.created_by}: ${said(issue.last.body)}` : '',
            ].filter(Boolean).join('\n')),
        ] : [],
        ...scope && left.length ? [
            `${issues.length ? 'After those, it' : 'It'} was working through ${scope.title} in project "${project}"; these are left, most urgent first. Take them one at a time (in-progress, comments, done):`,
            ...left.map(t => issueLine({...t, priority: t.priority ?? null}, statuses)),
        ] : [],
        `Read each in full (the issue tool, or curl ${api}/issues/<id>) before going on.`,
    ].join('\n')
}
