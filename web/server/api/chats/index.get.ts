// `GET /api/chats` → the chats running now and those that have ended, newest first, each with its messages: the owner's
// own, so a member gets a 403 (ORR-1195).
export default defineEventHandler(event => {
    ownersOwn(event.context.who as Who | undefined, 'The chat')
    return listChats()
})
