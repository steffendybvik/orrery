// `DELETE /api/projects/:project/milestones/:milestone/comments/:comment` → 204 (ORR-977).
export default defineEventHandler(async event => {
    await useStore().deleteMilestoneComment(param(event, 'project'), param(event, 'milestone'), commentId(event), await actorOf(event))
    return deleted(event)
})
