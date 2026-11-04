// `DELETE /api/chats/:chat` → 204: the owner deleting the chat (ORR-882), running or ended. One still running is ended
// first; the conversation goes, and what it made stays.
export default defineEventHandler(async event => {
    const actor = await authorize(event, 'chats.use')
    deleteChat(param(event, 'chat'), actor)
    setResponseStatus(event, 204)
    return null
})
