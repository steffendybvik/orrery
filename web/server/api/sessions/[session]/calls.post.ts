// `POST /api/sessions/:session/calls` `{tool, text}` → 204: a session's channel saying what one of its tool calls
// answered, kept for the Context page (ORR-549). Like `delivered`, it's the channel reporting, not a write to the roadmap.
export default defineEventHandler(async event => {
    const {tool, text} = await readBody<{tool?: unknown, text?: unknown}>(event) ?? {}
    if (typeof tool !== 'string' || !tool || typeof text !== 'string') throw badRequest('Send {tool, text}')
    // Only a session that's here, on a project the asker sees, and theirs (ORR-1373): an unknown one is a 404 before
    // anything is kept, so its Context page can't be written ahead of it, nor another person's.
    const session = listSessions().find(s => s.id === param(event, 'session'))
    if (!session) throw notFound(`No session ${param(event, 'session')}`)
    if (event.context?.who) await seenProjectOf(event, session.project)
    await needsBoard(event, session.project)
    await holdSession(event, session.id)
    noteContext(session.id, 'tool', tool, text)
    setResponseStatus(event, 204)
    return null
})
