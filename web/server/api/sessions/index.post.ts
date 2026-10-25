// `POST /api/sessions` {id?, pid?, project, name?, cwd?, event, message?, command?, reason?, source?} → the session: a Claude
// session's hook saying who it is and what it's doing (see channel/orrery-hook.mjs). `event` is the hook's event name.
// A `SessionStart` after a `/clear`, a compaction or a resume (`source`) also brings `brief`: what the session was
// working on, for the hook to hand the fresh context so the work carries on.
const RESUMED = ['clear', 'compact', 'resume']

export default defineEventHandler(async event => {
    const body = await readBody(event).catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body.project !== 'string' || typeof body.event !== 'string' || (!body.id && !body.pid)) {
        throw badRequest('Send {project, event} and the session as id or pid')
    }
    const text = (key: string) => typeof body[key] === 'string' && body[key] ? String(body[key]) : undefined
    const session = report({
        id: text('id'), pid: Number(body.pid) || undefined, project: body.project, name: text('name'),
        cwd: text('cwd'), event: body.event, message: text('message'), command: text('command')?.slice(0, 4000), reason: text('reason'),
    })
    if (!session || body.event !== 'SessionStart' || !RESUMED.includes(text('source') ?? '')) return session
    const api = `${getRequestURL(event).origin}/api/projects/${encodeURIComponent(body.project)}`
    return {...session, brief: await briefFor(body.project, session.id, api).catch(() => undefined)}
})

/** What the session has in progress, told to its fresh context; none when it has nothing. */
async function briefFor(project: string, session: string, api: string): Promise<string | undefined> {
    const store = useStore()
    const issues = await store.workingOn(project, sessionIds(session))
    if (!issues.length) return undefined
    const statuses = await store.statuses()
    const said = (body: string) => body.replace(/\s+/g, ' ').trim().slice(0, 300)
    return [
        `Orrery: this window's context was just cleared or compacted, and its channel is still connected. It was working on these issues in project "${project}"; carry on with them:`,
        ...issues.map(issue => [
            `- ${issue.id}: ${issue.title} [${[statuses.find(s => s.id === issue.column)?.name ?? issue.column, issue.priority].filter(Boolean).join(', ')}]`,
            issue.last ? `  last comment, by ${issue.last.createdBy}: ${said(issue.last.body)}` : '',
        ].filter(Boolean).join('\n')),
        `Read each in full (the issue tool, or curl ${api}/issues/<id>) before going on.`,
    ].join('\n')
}
