// `POST /api/projects/:project/chunks/:chunk/focus` {note?, session?, start?, status?} → {signal, listeners}: asks the
// Claude session (`*` for every session; without `session`, one orrery picks) on the project to work through the chunk's open
// issues now, or only those of `status` (`now`, …). `listeners` says how many sessions were listening to hear it. `start: true`, from the owner, starts a session for it when nobody's
// listening, even when work alone doesn't start one (`starts.on_signal` off).
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const {start, ...body} = ((await readBody(event).catch(() => null)) ?? {}) as {start?: unknown}
    const actor = await actorOf(event)
    // The owner asking for a session for it when nobody's listening: one starts even when work alone doesn't start one.
    const send = () => useStore().focusChunk(project, param(event, 'chunk'), body, actor)
    const signal = await (start === true && actor.owner ? startAsked.run(true, send) : send())
    setResponseStatus(event, 201)
    return {signal, listeners: listening(project)}
})
