// A chat is its project's (ORR-1347): one on a project the asker can't see, as in another person's workspace, is a
// 404 on every route under `/api/chats/:chat`, as if it weren't here, the owner's too. Its own session answering in it
// (`replies`) names nobody signed in, so goes on. After `chats-loaded`, so the chats kept are read back first.
export default defineEventHandler(async event => {
    const named = /^\/api\/chats\/([^/?#]+)/.exec(event.path)?.[1]
    if (!named || !event.context?.who) return
    let id: string
    try {
        id = decodeURIComponent(named)
    } catch {
        return
    }
    const chat = listChats().find(c => c.id === id)
    if (!chat) return
    try {
        await needsSeen(event, chat.project)
    } catch {
        throw notFound(`No chat ${id}`)
    }
})
