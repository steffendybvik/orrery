// `GET /api/projects/:project/issues/:issue/comments/:comment` → the comment.
export default defineEventHandler(async event => useStore().comment(param(event, 'project'), param(event, 'issue'), commentId(event)))
