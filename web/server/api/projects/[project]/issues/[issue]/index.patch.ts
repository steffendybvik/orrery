// `PATCH /api/projects/:project/issues/:issue` {title?, status?, plan?, priority?, assignee?, labels?, notes?,
// proposal?, parent?, milestone?, project?, position?} → the issue. Null clears plan, priority, assignee, labels, notes,
// parent and milestone, and commits a proposal; `project` moves it, with its sub-issues and comments, to another project.
// A session (`Orrery-Session`) starting, editing or moving one another session is working on is refused (409), though
// any may close it; two starting it at once go one after the other, so the second is refused. The owner's never are,
// nor their chat's (`Orrery-Chat`), which may change only what it says and where it sits (`asChatEdit`, 403 otherwise).
// With more than one person, moving it needs its person on the board it goes to (404 otherwise).
export default defineEventHandler(async event => {
    const chat = chatWrite(event)
    const body = chat ? asChatEdit(await readBody(event)) : await readBody(event)
    const session = (await actorOf(event)).owner || chat ? undefined : sessionHeader(event)
    const [project, id] = [param(event, 'project'), param(event, 'issue')]
    const to = (body as {project?: unknown} | null)?.project
    if (typeof to === 'string') await needsBoard(event, to)
    const update = async () => useStore().updateIssue(project, id, body, await actorOf(event))
    const issue = session ? await useStore().claimed(project, id, (body as {status?: string} | null)?.status, currentId(session), update) : await update()
    // Started by a session: whether it carries another issue's context into it (ORR-968).
    if (session && issue.kind === 'started' && (body as {status?: unknown} | null)?.status !== undefined) {
        const carry = startedIssue(currentId(session), {project: issue.project, id: issue.id, parent: issue.parent, milestone: issue.milestone, epic: issue.epic})
        // Kept, so how often it happens shows before sessions clear for it.
        if (carry) {
            const {session: on, carried: {from, to, tokens}} = carry
            useEventLog().note({level: 'info', kind: 'session.carried_over', project: issue.project, message: `${on.name} started ${to} with ${Math.round(tokens / 1000)}k tokens of ${from} in its context`, details: {session: on.id, from, to, tokens}})
        }
    }
    // Moved, it's somewhere its address doesn't say.
    if (issue.project !== project) workedOn(event, issue)
    return issue
})
