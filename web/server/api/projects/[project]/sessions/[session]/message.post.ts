// `POST /api/projects/:project/sessions/:session/message` {text, preset?} → 201 the signal: the owner's own words to
// that one session, through its channel; with `preset`, a preset's text (tweaked or not), labelled by its name. 404 for a session that isn't on the project; 409 for one that can't hear it now.
// The owner's chat can't send here: it asks the owner in the chat, and their Send sends it (`askSend`, ORR-416).
export default defineEventHandler(async event => {
    const [project, id] = [param(event, 'project'), param(event, 'session')]
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner messages a session; send Orrery-Actor: <owner>')
    const session = listSessions(project).find(s => s.id === currentId(id))
    if (!session) throw notFound(`No session ${id} in ${project}`)
    if (!hearing(project, session.id)) throw conflict(`${session.name} isn't listening, so a message can't reach it`)
    const body = await readBody(event) as {text?: unknown, preset?: unknown} | null
    const signal = await useStore().messageSession(project, session.id, body?.text, actor, body?.preset)
    messaged(actor, project, session.name)
    return created(event, signal)
})
