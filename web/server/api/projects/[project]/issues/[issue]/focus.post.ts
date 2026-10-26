// `POST /api/projects/:project/issues/:issue/focus` {note?, session?} → {signal, listeners}: asks the Claude
// session (`*` for every session; without `session`, the one on the issue or one Orrery picks) on the project to work on the issue now. `listeners`
// says how many sessions were listening to hear it.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const signal = await useStore().focus(project, param(event, 'issue'), await readBody(event).catch(() => ({})), await actorOf(event))
    setResponseStatus(event, 201)
    return {signal, listeners: listening(project)}
})
