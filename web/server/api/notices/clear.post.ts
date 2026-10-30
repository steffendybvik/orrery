// `POST /api/notices/clear` {ids, proposals} or {before} → {cleared}: takes those out of the bell (comments
// stay on their issues, proposals pending): comments by id and proposals by `{project, issue}`, or all comments
// made at or before that time. Each person's bell is their own (ORR-658), so only they can, and never a session.
export default defineEventHandler(async event => {
    const person = (await memberAsking(event))?.person
    if (!person) await authorize(event, 'notices.clear')
    return {cleared: await useStore().clearNotices(await readBody(event).catch(() => ({})), person)}
})
