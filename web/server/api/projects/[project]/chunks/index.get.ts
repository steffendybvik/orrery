// `GET /api/projects/:project/chunks` → its chunks, with their columns, counts and top-level issue ids.
export default defineEventHandler(async event => useStore().listChunks(param(event, 'project')))
