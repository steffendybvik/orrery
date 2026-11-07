// `GET /api/projects/:project/sessions/:session/next` → `{issues, text}`: a session asking for its next issue itself
// (ORR-521, the channel's `next`), with what the push would hand it (pick.ts): the issues it may start, most urgent
// first, and the message they go with; or none, and why (it still has work, a run with issues left, nothing free).
// 404 for a session orrery doesn't know on the project.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const id = param(event, 'session')
    const session = sessionNow(id)
    if (!session || session.project !== project && !session.also?.includes(project)) {
        throw notFound(`No session ${id} on ${project}`)
    }
    const next = await nextFor(id)
    if (!next) throw notFound(`No session ${id} on ${project}`)
    return next
})
