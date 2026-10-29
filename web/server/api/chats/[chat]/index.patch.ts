// `PATCH /api/chats/:chat` {issues} → the chat: the owner choosing where the issues it makes land from now on, `todo` or
// `backlog`. Its own session can't (middleware/chat.ts), so where they land stays the owner's call.
export default defineEventHandler(async event => {
    await authorize(event, 'chats.use')
    const body = await readBody(event).catch(() => null) as {issues?: unknown} | null
    if (body?.issues === undefined) throw badRequest('Send {issues}: "todo" or "backlog"')
    return landChatIssues(param(event, 'chat'), chatIssuesOf(body.issues))
})
