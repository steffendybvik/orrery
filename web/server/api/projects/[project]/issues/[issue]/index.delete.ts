// `DELETE /api/projects/:project/issues/:issue` → 204; its sub-issues and comments go too.
export default defineEventHandler(async event => {
    await useStore().deleteIssue(param(event, 'project'), param(event, 'issue'), await actorOf(event))
    return deleted(event)
})
