// `PATCH /api/projects/:project/milestones/:milestone/comments/:comment` {body} → the comment. The owner's are theirs, and
// a member's theirs and their agents' (ORR-977).
export default defineEventHandler(async event => {
    const [project, milestone] = [param(event, 'project'), param(event, 'milestone')]
    return useStore().updateMilestoneComment(project, milestone, commentId(event), await readBody(event), await actorOf(event))
})
