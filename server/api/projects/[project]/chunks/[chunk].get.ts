// `GET /api/projects/:project/chunks/:chunk` → the chunk with its issues.
export default defineEventHandler(event => useStore().chunk(param(event, 'project'), param(event, 'chunk')))
