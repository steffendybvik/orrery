// Anyone signed in, the owner too, reaches only the projects they can see (ORR-1195, ORR-1347): a read or write of
// `/api/projects/:project/…` on any other, such as one in another person's workspace, is a 404, as if it weren't here.
// The Rust API holds its own routes already; this holds the ones this server answers itself (sessions, context,
// launches, pulls, artifacts), with one check before any of them.
export default defineEventHandler(async event => {
    if (event.method === 'OPTIONS') return
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
