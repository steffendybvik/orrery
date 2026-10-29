// `POST /api/chats/:chat/requests/:message` {allow} → the request, answered: the owner allowing (the setting or schedule is
// saved as asked, the issues moved, the message sent) or denying it, from the page. Never a chat's session's, so it can't allow its own; 409 once answered or expired.
export default defineEventHandler(async event => {
    const actor = await authorize(event, 'chats.use')
    const body = await readBody(event).catch(() => null) as {allow?: unknown} | null
    if (typeof body?.allow !== 'boolean') throw badRequest('Send {"allow": true} or {"allow": false}')
    return await answer(param(event, 'chat'), Number(param(event, 'message')), body.allow, actor)
})
