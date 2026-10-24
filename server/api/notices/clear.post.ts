// `POST /api/notices/clear` {ids} or {before} → {cleared}: takes those agents' comments out of the bell
// (they stay on their issues): the ones by id, or all made at or before that time. The bell is the
// owner's, so only the owner can.
export default defineEventHandler(async event => {
    if (!actorOf(event).owner) throw forbidden("Only the owner clears the bell's notices; send Orrery-Actor: <owner>")
    return {cleared: useStore().clearNotices(await readBody(event).catch(() => ({})))}
})
