// `POST /api/notices/read` {ids} → {read}: marks comments read, by id, as opening one on the notifications page does. It
// leaves what the bell counts alone. Each person's are their own, as with clearing, and never a session's.
export default defineEventHandler(async event => {
    const person = (await memberAsking(event))?.person
    if (!person) await authorize(event, 'notices.clear')
    return {read: await useStore().readNotices(await readBody(event).catch(() => ({})), person)}
})
