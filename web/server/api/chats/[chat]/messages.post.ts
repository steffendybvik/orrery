// `POST /api/chats/:chat/messages` {text, images?, page?} → 201 the message: the owner writing in the chat, with the ids
// of uploads they pasted (`POST /api/uploads`) and the page they're on (`{path, title?}`). It goes to the chat's session
// alone.
export default defineEventHandler(async event => {
    const actor = await authorize(event, 'chats.use')
    const body = await readBody(event).catch(() => null) as {text?: unknown, images?: unknown, page?: unknown} | null
    return created(event, await say(param(event, 'chat'), body?.text, body?.images, actor, body?.page))
})
