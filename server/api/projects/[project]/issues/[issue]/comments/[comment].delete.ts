// `DELETE /api/projects/:project/issues/:issue/comments/:comment` → 204.
export default defineEventHandler(event => {
    useStore().deleteComment(param(event, 'project'), param(event, 'issue'), commentId(event), actorOf(event))
    return deleted(event)
})
