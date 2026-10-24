// `GET /api/projects/:project/docs` → its docs, without their text.
export default defineEventHandler(event => useStore().listDocs(param(event, 'project')))
