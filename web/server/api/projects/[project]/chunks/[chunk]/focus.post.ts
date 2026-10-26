// `POST /api/projects/:project/chunks/:chunk/focus` {note?, session?, status?} → {signal, listeners}: asks the
// Claude session (`*` for every session; without `session`, one Orrery picks) on the project to work through the chunk's open
// issues now, or only those of `status` (`now`, …). `listeners` says how many sessions were listening to hear it.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const signal = await useStore().focusChunk(project, param(event, 'chunk'), await readBody(event).catch(() => ({})), await actorOf(event))
    setResponseStatus(event, 201)
    return {signal, listeners: listening(project)}
})
