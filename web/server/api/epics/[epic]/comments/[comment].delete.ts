// `DELETE /api/epics/:epic/comments/:comment` → 204 (ORR-977).
export default defineEventHandler(async event => {
    await useStore().deleteEpicComment(await epicId(event), commentId(event), await actorOf(event))
    return deleted(event)
})
