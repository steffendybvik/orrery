// `POST /api/projects/:project/chunks` {title, summary?, priority?, position?} → the new chunk, with the project's next number.
export default defineEventHandler(async event => created(event, await useStore().createChunk(param(event, 'project'), await readBody(event), await actorOf(event))))
