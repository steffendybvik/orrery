// `POST /api/sessions` {id?, pid?, project, name?, cwd?, event, message?, command?, reason?, source?} → the session: a Claude
// session's hook saying who it is and what it's doing (see channel/orrery-hook.mjs). `event` is the hook's event name.
// A `SessionStart` after a `/clear`, a compaction or a resume (`source`) also brings `brief`: what the session was
// working on, for the hook to hand the fresh context so the work carries on.
// What happened to the session, by `source`, for the brief's first line.
const RESUMED: Record<string, string> = {
    clear: "this window's context was just cleared",
    compact: "this window's context was just compacted",
    resume: 'this session was just resumed',
}

export default defineEventHandler(async event => {
    const body = await readBody(event).catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body.project !== 'string' || typeof body.event !== 'string' || (!body.id && !body.pid)) {
        throw badRequest('Send {project, event} and the session as id or pid')
    }
    const text = (key: string) => typeof body[key] === 'string' && body[key] ? String(body[key]) : undefined
    const session = report({
        id: text('id'), pid: Number(body.pid) || undefined, project: body.project, name: text('name'),
        cwd: text('cwd'), event: body.event, message: text('message'), command: text('command')?.slice(0, 4000), reason: text('reason'), source: text('source'),
    })
    if (session && body.event === 'Stop') considerClear(session.project, session.id)
    const source = text('source')
    if (!session || body.event !== 'SessionStart' || !source || !Object.hasOwn(RESUMED, source)) return session
    const api = `${getRequestURL(event).origin}/api/projects/${encodeURIComponent(body.project)}`
    return {...session, brief: await briefFor(body.project, session.id, RESUMED[source]!, api).catch(() => undefined)}
})

/** What the session has in progress, told to its fresh context, and what's left of the chunk or scope it was
 * working through; none when it has neither. */
async function briefFor(project: string, session: string, happened: string, api: string): Promise<string | undefined> {
    const store = useStore()
    const issues = await store.workingOn(project, sessionIds(session))
    const run = runOf(session)
    const scope = run && run.project === project ? await scopeOf(store, project, run).catch(() => undefined) : undefined
    const left = scope?.open.filter(t => !issues.some(i => i.id === t.id)) ?? []
    if (!issues.length && !left.length) return undefined
    const statuses = await store.statuses()
    const said = (body: string) => body.replace(/\s+/g, ' ').trim().slice(0, 300)
    return [
        `Orrery: ${happened}.`,
        ...issues.length ? [
            `It was working on these issues in project "${project}"; carry on with them:`,
            ...issues.map(issue => [
                issueLine(issue, statuses),
                issue.last ? `  last comment, by ${issue.last.created_by}: ${said(issue.last.body)}` : '',
            ].filter(Boolean).join('\n')),
        ] : [],
        ...left.length ? [
            `${issues.length ? 'After those, it' : 'It'} was working through ${scope!.title} in project "${project}"; these are left, most urgent first. Take them one at a time (in-progress, comments, done):`,
            ...left.map(t => issueLine({...t, priority: t.priority ?? null}, statuses)),
        ] : [],
        `Read each in full (the issue tool, or curl ${api}/issues/<id>) before going on.`,
    ].join('\n')
}
