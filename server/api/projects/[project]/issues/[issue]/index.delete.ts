// `DELETE /api/projects/:project/issues/:issue` → 204; its sub-issues and comments go too.
export default defineEventHandler(event => {
    useStore().deleteIssue(param(event, 'project'), param(event, 'issue'), actorOf(event))
    return deleted(event)
})
