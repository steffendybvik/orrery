// `POST /api/chats/:chat/requests` {setting, value, why?} | {schedule, id?, why?} → 201 the message: the chat's session
// asking to change one App setting (`CHAT_SETTINGS`), or to make a schedule or change schedule `id`
// (`CHAT_SCHEDULE_FIELDS`), shown in the chat with Allow and Deny. Nothing is saved until the owner allows it. Only that
// chat's session.
export default defineEventHandler(async event => {
    const id = param(event, 'chat')
    if (!chatWrite(event) || getHeader(event, 'orrery-launch') !== id) throw forbidden("Only the chat's own session asks in it")
    return created(event, await ask(id, await readBody(event).catch(() => null)))
})
