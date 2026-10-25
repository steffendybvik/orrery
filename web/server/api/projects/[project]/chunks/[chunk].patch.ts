// `PATCH /api/projects/:project/chunks/:chunk` {title?, summary?, position?} → the chunk.
export default defineEventHandler(async event => useStore().updateChunk(param(event, 'project'), param(event, 'chunk'), await readBody(event)))
