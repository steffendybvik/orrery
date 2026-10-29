// `POST /api/chats/:chat/requests` {setting, value, why?} | {schedule, id?, why?} | {move, why?} | {message, why?} → 201 the
// message: the chat's session asking to change one App setting (`CHAT_SETTINGS`), to make a schedule or change schedule
// `id` (`CHAT_SCHEDULE_FIELDS`), or to move or assign issues (`move` is {ids, status?, assignee?}), shown in the chat with
// Allow and Deny, or to message sessions (`message` is {text, session}
// or {text, projects?, states?}), shown with who it goes to and Send and Don't send. Nothing is saved or sent until the
// owner says so. Only that chat's session.
export default defineEventHandler(async event => {
    const id = param(event, 'chat')
    if (!chatWrite(event) || getHeader(event, 'orrery-launch') !== id) throw forbidden("Only the chat's own session asks in it")
    return created(event, await ask(id, await readBody(event).catch(() => null)))
})
