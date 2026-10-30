// `PATCH /api/projects/:project/issues/:issue/comments/:comment` {body} → the comment. Refused (409) to a session while
// another session is working on the issue: writing a comment there is open (ORR-613), editing one isn't (ORR-627).
export default defineEventHandler(async event => {
    const [project, issue] = [param(event, 'project'), param(event, 'issue')]
    await claimFor(event, project, issue)
    return useStore().updateComment(project, issue, commentId(event), await readBody(event), await actorOf(event))
})
