// `PATCH /api/projects/:project/issues/:issue` {title?, status?, plan?, priority?, assignee?, labels?, notes?,
// proposal?, parent?, chunk?, project?, position?} → the issue. Null clears plan, priority, assignee, labels, notes,
// parent and chunk, and commits a proposal; `project` moves it, with its sub-issues and comments, to another project.
// A session (`Orrery-Session`) starting, editing or moving one another session is working on is refused (409), though
// any may close it; two starting it at once go one after the other, so the second is refused. The owner's never are,
// nor their chat's (`Orrery-Chat`), which may change only what it says and where it sits (`asChatEdit`, 403 otherwise).
export default defineEventHandler(async event => {
    const chat = chatWrite(event)
    const body = chat ? asChatEdit(await readBody(event)) : await readBody(event)
    const session = (await actorOf(event)).owner || chat ? undefined : getHeader(event, 'orrery-session')?.trim()
    const [project, id] = [param(event, 'project'), param(event, 'issue')]
    const update = async () => useStore().updateIssue(project, id, body, await actorOf(event))
    const issue = session ? await useStore().claimed(project, id, (body as {status?: string} | null)?.status, currentId(session), update) : await update()
    // Moved, it's somewhere its address doesn't say.
    if (issue.project !== project) workedOn(event, issue)
    return issue
})
