// `GET /api/projects/:project/issues/:issue/comments` → its comments, oldest first.
export default defineEventHandler(event => useStore().listComments(param(event, 'project'), param(event, 'issue')))
