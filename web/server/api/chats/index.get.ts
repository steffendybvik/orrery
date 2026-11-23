// `GET /api/chats` → the chats running now and those that have ended, newest first, each with its messages: the owner's
// own, so a member gets a 403 (ORR-1195), and only those on the projects of the workspace the page is in (ORR-1347).
export default defineEventHandler(async event => {
    ownersOwn(event.context?.who as Who | undefined, 'The chat')
    const sees = await listedSees(event)
    return sees ? listChats().filter(chat => sees.has(chat.project)) : listChats()
})
