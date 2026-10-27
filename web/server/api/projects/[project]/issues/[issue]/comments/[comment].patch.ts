// `PATCH /api/projects/:project/issues/:issue/comments/:comment` {body} → the comment. Refused (409) to a session while
// another session is working on the issue.
export default defineEventHandler(async event => {
    const [project, issue] = [param(event, 'project'), param(event, 'issue')]
    await claimFor(event, project, issue)
    return useStore().updateComment(project, issue, commentId(event), await readBody(event), await actorOf(event))
})
