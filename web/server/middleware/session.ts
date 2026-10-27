// A write that says which Claude session made it (`Orrery-Session: <id>`, as the channel's tools send)
// marks that session as working the issue it went to, once it succeeds, so the owner's comments on the
// issue go to that session. Writes through curl get the same from the session's hooks instead. An issue
// the write made, or moved to another project, isn't in its address: its route marks it (`workedOn`).
const ISSUE = /^\/api\/projects\/([^/?]+)\/issues\/([^/?]+)/

export default defineEventHandler(event => {
    const session = getHeader(event, 'orrery-session')?.trim()
    const match = ISSUE.exec(event.path)
    if (!session || !match?.[1] || !match[2] || !['POST', 'PUT', 'PATCH'].includes(event.method)) return
    const [project, issue] = [decoded(match[1]), decoded(match[2])]
    event.node.res.once('finish', () => {
        if (event.node.res.statusCode < 400) workedOn(event, {project, id: issue})
    })
})
