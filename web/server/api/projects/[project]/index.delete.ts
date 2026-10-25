// `DELETE /api/projects/:project` → 204; everything in it goes too (chunks, issues, comments, docs,
// schedules, signals), for good. Agents can't while it holds anything of the owner's.
export default defineEventHandler(async event => {
    await useStore().deleteProject(param(event, 'project'), await actorOf(event))
    return deleted(event)
})
