// `DELETE /api/projects/:project/issues/:issue/comments/:comment` → 204.
export default defineEventHandler(async event => {
    await useStore().deleteComment(param(event, 'project'), param(event, 'issue'), commentId(event), await actorOf(event))
    return deleted(event)
})
