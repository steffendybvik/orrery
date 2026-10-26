// `PATCH /api/projects/:project/issues/:issue` {title?, status?, plan?, priority?, assignee?, labels?, notes?,
// proposal?, parent?, chunk?, project?, position?} → the issue. Null clears plan, priority, assignee, labels, notes,
// parent and chunk, and commits a proposal; `project` moves it, with its sub-issues and comments, to another project.
// A session (`Orrery-Session`) starting one another session is working on is refused (409); two starting it at
// once go one after the other, so the second is refused.
export default defineEventHandler(async event => {
    const body = await readBody(event)
    const session = getHeader(event, 'orrery-session')?.trim()
    const [project, id] = [param(event, 'project'), param(event, 'issue')]
    const update = async () => useStore().updateIssue(project, id, body, await actorOf(event))
    const issue = session ? await useStore().claimed(project, id, (body as {status?: string} | null)?.status, currentId(session), update) : await update()
    // Moved, it's somewhere its address doesn't say.
    if (issue.project !== project) workedOn(event, issue)
    return issue
})
