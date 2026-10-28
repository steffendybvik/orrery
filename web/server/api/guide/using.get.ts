// `GET /api/guide/using` → how Orrery works, page by page (docs/using.md): what the channel's `guide` tool answers a
// session asked about Orrery itself, in any project.
export default defineEventHandler(async event => {
    setResponseHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
    return usingGuide()
})
