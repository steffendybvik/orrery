// `DELETE /api/epics/:epic` → 204. Its issues stay where they are, in no epic; one the owner made is theirs to delete.
export default defineEventHandler(async event => {
    await useStore().deleteEpic(await epicId(event), await actorOf(event))
    return deleted(event)
})
