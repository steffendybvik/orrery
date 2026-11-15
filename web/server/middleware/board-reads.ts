// A member who isn't the owner reads only the projects they can see (ORR-1195): a read of `/api/projects/:project/…` on
// any other is a 404, as if it weren't here. The Rust API holds its own routes already; this holds the ones this server
// answers itself (sessions, context, launches, pulls, artifacts), with one check before any of them.
export default defineEventHandler(async event => {
    if (event.method !== 'GET' && event.method !== 'HEAD') return
    const project = /^\/api\/projects\/([^/?#]+)\/./.exec(event.path)?.[1]
    if (!project) return
    let id: string
    try {
        id = decodeURIComponent(project).toLowerCase()
    } catch {
        return
    }
    await needsSeen(event, id)
})
