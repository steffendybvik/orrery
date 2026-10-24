// `PATCH /api/projects/:project/issues/:issue/comments/:comment` {body} → the comment.
export default defineEventHandler(async event => useStore().updateComment(param(event, 'project'), param(event, 'issue'), commentId(event), await readBody(event), actorOf(event)))
