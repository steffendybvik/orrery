// `POST /api/projects/:project/issues/:issue/comments` {body} → the new comment. Any session may comment on one another
// session is working on (ORR-613): it neither starts nor changes the issue, and it's how a reviewer's findings reach
// that session.
export default defineEventHandler(async event => {
    const [project, issue] = [param(event, 'project'), param(event, 'issue')]
    return created(event, await useStore().createComment(project, issue, await readBody(event), await actorOf(event)))
})
