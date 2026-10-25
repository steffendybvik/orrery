// `POST /api/projects/:project/chunks` {title, id?, summary?, position?} → the new chunk.
export default defineEventHandler(async event => created(event, await useStore().createChunk(param(event, 'project'), await readBody(event), await actorOf(event))))
