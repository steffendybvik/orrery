// `GET /api/projects/:project/doc-sections` → its docs' sections, A–Z: the ones docs are filed under, and empty ones made.
export default defineEventHandler(async event => useStore().docSections(param(event, 'project')))
