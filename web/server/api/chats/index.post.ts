// `POST /api/chats` {project, issues?} → 201 the chat: the owner starting a chat on the project, a session started for
// it alone through the project's launcher (one that can start chats), the issues it makes landing in `issues` (`todo`,
// the default, or `backlog`). It needs only that launcher: a chat counts towards no limit, and starts needn't be
// turned on.
export default defineEventHandler(async event => {
    if (!(await actorOf(event)).owner) throw forbidden('Only the owner chats; send Orrery-Actor: <owner>')
    const body = await readBody(event).catch(() => null) as {project?: unknown, issues?: unknown} | null
    if (typeof body?.project !== 'string' || !body.project) throw badRequest('Send {project}: the project to chat about')
    const project = await useStore().projectId(body.project)
    return created(event, await openChat(project, chatIssuesOf(body.issues)))
})
