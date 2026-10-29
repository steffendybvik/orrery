// `POST /api/chats/:chat/end` → 204: the owner ending the chat; its session is stopped and the chat goes.
export default defineEventHandler(async event => {
    await authorize(event, 'chats.use')
    endChat(param(event, 'chat'))
    setResponseStatus(event, 204)
    return null
})
