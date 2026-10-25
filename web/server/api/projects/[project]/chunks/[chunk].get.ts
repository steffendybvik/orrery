// `GET /api/projects/:project/chunks/:chunk` → the chunk with its issues.
export default defineEventHandler(async event => useStore().chunk(param(event, 'project'), param(event, 'chunk')))
