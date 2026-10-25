// `DELETE /api/projects/:project/docs/:doc` → 204.
export default defineEventHandler(async event => {
    await useStore().deleteDoc(param(event, 'project'), param(event, 'doc'), await actorOf(event))
    return deleted(event)
})
