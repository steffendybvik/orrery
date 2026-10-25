// `DELETE /api/projects/:project/chunks/:chunk` → 204; its issues stay, in no chunk.
export default defineEventHandler(async event => {
    await useStore().deleteChunk(param(event, 'project'), param(event, 'chunk'), await actorOf(event))
    return deleted(event)
})
