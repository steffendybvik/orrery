// `POST /api/projects/:project/launches/:launch/stop` → the session: the owner stopping a session orrery
// started. Its launcher kills it, and the session is gone once the launcher says so.
export default defineEventHandler(async event => {
    if (!await memberAsking(event)) await authorize(event, 'sessions.start')
    return stopLaunch(param(event, 'project'), param(event, 'launch'))
})
