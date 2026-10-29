// `POST /api/chats/:chat/replies` {text} → 201 the message: the chat's session answering (its channel's `reply` tool).
// Only that session's: its channel says it's a chat (`Orrery-Chat`), started for this one (`Orrery-Launch`).
export default defineEventHandler(async event => {
    await authorize(event, 'chats.reply')
    const id = param(event, 'chat')
    if (!chatWrite(event) || getHeader(event, 'orrery-launch') !== id) throw forbidden("Only the chat's own session answers in it")
    const body = await readBody(event).catch(() => null) as {text?: unknown} | null
    return created(event, reply(id, body?.text))
})
