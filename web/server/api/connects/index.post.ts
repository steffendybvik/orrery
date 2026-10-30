// `POST /api/connects` → 201 the request: the owner pressing Connect a repo. A launcher opens the folder picker on its
// machine; 409 with none that can. It takes no folder, as orrery never names one (SECURITY.md).
export default defineEventHandler(async event => {
    await authorize(event, 'connects.start')
    setResponseStatus(event, 201)
    return askConnect()
})
