// `PATCH /api/projects/:project/issues/:issue` {title?, status?, plan?, priority?, assignee?, labels?, notes?,
// proposal?, parent?, chunk?, project?, position?} → the issue. Null clears plan, priority, assignee, labels, notes,
// parent and chunk, and commits a proposal; `project` moves it, with its sub-issues and comments, to another project.
// A session (`Orrery-Session`) starting one another session is working on is refused (409).
export default defineEventHandler(async event => {
    const body = await readBody(event)
    const session = getHeader(event, 'orrery-session')?.trim()
    if (session) await useStore().claim(param(event, 'project'), param(event, 'issue'), (body as {status?: string} | null)?.status, currentId(session))
    const issue = await useStore().updateIssue(param(event, 'project'), param(event, 'issue'), body, await actorOf(event))
    // Moved, it's somewhere its address doesn't say.
    if (issue.project !== param(event, 'project')) workedOn(event, issue)
    return issue
})
