// `POST /api/chats/:chat/clear` → 201 the message: the owner clearing the chat's context (`/clear`). Its session keeps
// running with a fresh context, and the chat marks the cut with a message that has `cleared`.
export default defineEventHandler(async event => {
    await authorize(event, 'chats.use')
    return created(event, clearChat(param(event, 'chat')))
})
