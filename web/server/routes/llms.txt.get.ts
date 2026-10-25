// `GET /llms.txt` → how an agent uses Orrery, and the projects in it (the llms.txt convention).
export default defineEventHandler(async event => {
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    return overview(event)
})
