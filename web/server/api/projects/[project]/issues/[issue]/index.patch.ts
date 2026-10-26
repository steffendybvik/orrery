// `PATCH /api/projects/:project/issues/:issue` {title?, status?, plan?, priority?, assignee?, labels?, notes?,
// proposal?, parent?, chunk?, project?, position?} → the issue. Null clears plan, priority, assignee, labels, notes,
// parent and chunk, and commits a proposal; `project` moves it, with its sub-issues and comments, to another project.
export default defineEventHandler(async event => {
    const issue = await useStore().updateIssue(param(event, 'project'), param(event, 'issue'), await readBody(event), await actorOf(event))
    // Moved, it's somewhere its address doesn't say.
    if (issue.project !== param(event, 'project')) workedOn(event, issue)
    return issue
})
