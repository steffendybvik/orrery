// `GET /api/chats/:chat` → the chat, with its messages: running, or ended (ORR-870), kept across restarts (ORR-877). The
// owner's own, so a member gets a 403 (ORR-1195).
export default defineEventHandler(event => {
    ownersOwn(event.context.who as Who | undefined, 'The chat')
    return readChat(param(event, 'chat'))
})
