// `POST /api/notices/clear` {ids, proposals} or {before} → {cleared}: takes those out of the bell (comments
// stay on their issues, proposals pending): comments by id and proposals by `{project, issue}`, or all comments
// made at or before that time. The bell is the owner's, so only the owner can.
export default defineEventHandler(async event => {
    if (!(await actorOf(event)).owner) throw forbidden("Only the owner clears the bell's notices; send Orrery-Actor: <owner>")
    return {cleared: await useStore().clearNotices(await readBody(event).catch(() => ({})))}
})
