// `DELETE /api/projects/:project/chunks/:chunk` → 204; its issues stay, in no chunk.
export default defineEventHandler(event => {
    useStore().deleteChunk(param(event, 'project'), param(event, 'chunk'), actorOf(event))
    return deleted(event)
})
