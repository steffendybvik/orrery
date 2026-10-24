// `GET /api/projects/:project/docs/:doc` → the doc with its Markdown.
export default defineEventHandler(event => useStore().doc(param(event, 'project'), param(event, 'doc')))
