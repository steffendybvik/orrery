// `POST /api/projects/:project/sessions/:session/message` {text} → 201 the signal: the owner's own words to that one
// session, through its channel. 404 for a session that isn't on the project; 409 for one that can't hear it now.
export default defineEventHandler(async event => {
    const [project, id] = [param(event, 'project'), param(event, 'session')]
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner messages a session; send Orrery-Actor: <owner>')
    const session = listSessions(project).find(s => s.id === currentId(id))
    if (!session) throw notFound(`No session ${id} in ${project}`)
    if (!hearing(project, session.id)) throw conflict(`${session.name} isn't listening, so a message can't reach it`)
    const body = await readBody(event) as {text?: unknown} | null
    return created(event, await useStore().messageSession(project, session.id, body?.text, actor))
})
