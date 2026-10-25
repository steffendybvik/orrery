// A write that says which Claude session made it (`Orrery-Session: <id>`, as the channel's tools send)
// marks that session as working the issue it went to, once it succeeds, so the owner's comments on the
// issue go to that session. Writes through curl get the same from the session's hooks instead.
const ISSUE = /^\/api\/projects\/([^/?]+)\/issues\/([^/?]+)/

export default defineEventHandler(event => {
    const session = getHeader(event, 'orrery-session')?.trim()
    const match = ISSUE.exec(event.path)
    if (!session || !match || !['POST', 'PUT', 'PATCH'].includes(event.method)) return
    const [project, issue] = [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)]
    event.node.res.once('finish', () => {
        // The channel's id may be from before a `/clear`: the issue goes to the session as it is now.
        if (event.node.res.statusCode < 400) useStore().workedBy(project, issue, currentId(session)).catch(() => {})
    })
})
