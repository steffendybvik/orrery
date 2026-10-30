// `POST /api/sessions/:session/calls` `{tool, text}` → 204: a session's channel saying what one of its tool calls
// answered, kept for the Context page (ORR-549). Like `delivered`, it's the channel reporting, not a write to the roadmap.
export default defineEventHandler(async event => {
    const {tool, text} = await readBody<{tool?: unknown, text?: unknown}>(event) ?? {}
    if (typeof tool !== 'string' || !tool || typeof text !== 'string') throw badRequest('Send {tool, text}')
    const session = listSessions().find(s => s.id === param(event, 'session'))
    if (session) await needsBoard(event, session.project)
    noteContext(param(event, 'session'), 'tool', tool, text)
    setResponseStatus(event, 204)
    return null
})
