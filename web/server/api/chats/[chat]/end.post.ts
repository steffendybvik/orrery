// `POST /api/chats/:chat/end` → 204: the owner ending the chat; its session is stopped and the chat goes.
export default defineEventHandler(async event => {
    if (!(await actorOf(event)).owner) throw forbidden('Only the owner ends a chat; send Orrery-Actor: <owner>')
    endChat(param(event, 'chat'))
    setResponseStatus(event, 204)
    return null
})
