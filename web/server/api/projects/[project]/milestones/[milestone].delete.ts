// `DELETE /api/projects/:project/milestones/:milestone` → 204; its issues stay, in no milestone.
export default defineEventHandler(async event => {
    await useStore().deleteMilestone(param(event, 'project'), param(event, 'milestone'), await actorOf(event))
    return deleted(event)
})
