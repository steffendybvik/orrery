// `GET /api/projects/:project/deleted-docs` → its docs that are gone and can come back, the latest removed first.
export default defineEventHandler(async event => useStore().deletedDocs(param(event, 'project')))
