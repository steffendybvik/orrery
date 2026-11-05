// `POST /api/projects/:project/milestones/:milestone/comments` {body} → the new comment (ORR-977): words on the milestone's
// page, which ask nothing and wake no session.
export default defineEventHandler(async event => {
    const [project, milestone] = [param(event, 'project'), param(event, 'milestone')]
    return created(event, await useStore().createMilestoneComment(project, milestone, await readBody(event), await actorOf(event)))
})
