// `GET /llms-full.txt` → /llms.txt and the whole API reference, in one file.
export default defineEventHandler(async event => {
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    return `${overview(event)}\n---\n\n${await apiReference()}`
})
