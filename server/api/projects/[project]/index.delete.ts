// `DELETE /api/projects/:project` → 204; its chunks, issues and comments go too.
export default defineEventHandler(event => {
    useStore().deleteProject(param(event, 'project'), actorOf(event))
    return deleted(event)
})
