// `PATCH /api/epics/:epic/comments/:comment` {body} → the comment. The owner's are theirs (ORR-977).
export default defineEventHandler(async event => useStore().updateEpicComment(await epicId(event), commentId(event), await readBody(event), await actorOf(event)))
