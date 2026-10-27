// `POST /api/projects/:project/issues/:issue/comments` {body} → the new comment. A session (`Orrery-Session`) commenting on
// one another session is working on is refused (409).
export default defineEventHandler(async event => {
    const [project, issue] = [param(event, 'project'), param(event, 'issue')]
    await claimFor(event, project, issue)
    return created(event, await useStore().createComment(project, issue, await readBody(event), await actorOf(event)))
})
