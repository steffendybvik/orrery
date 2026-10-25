// `POST /api/projects/:project/issues/:issue/comments` {body} → the new comment.
export default defineEventHandler(async event => created(event, await useStore().createComment(param(event, 'project'), param(event, 'issue'), await readBody(event), await actorOf(event))))
