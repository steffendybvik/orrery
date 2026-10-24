// `DELETE /api/projects/:project/docs/:doc` → 204.
export default defineEventHandler(event => {
    useStore().deleteDoc(param(event, 'project'), param(event, 'doc'), actorOf(event))
    return deleted(event)
})
