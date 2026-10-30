// `PATCH /api/projects/:project/issues/:issue/comments/:comment` {body} → the comment. Like writing one, open to a session
// while another is working on the issue (ORR-613).
export default defineEventHandler(async event => {
    const [project, issue] = [param(event, 'project'), param(event, 'issue')]
    return useStore().updateComment(project, issue, commentId(event), await readBody(event), await actorOf(event))
})
