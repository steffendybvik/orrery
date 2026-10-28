// `GET /api/guide/using` → how orrery works, page by page (docs/using.md): what the channel's `guide` tool answers a
// session asked about orrery itself, in any project.
export default defineEventHandler(async event => {
    setResponseHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
    return usingGuide()
})
