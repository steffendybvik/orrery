// `GET /api/guide` → the API reference (docs/API.md), for agents to read.
export default defineEventHandler(async event => {
    setResponseHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
    return apiReference()
})
