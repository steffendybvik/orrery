// `POST /api/projects/:project/launches/:launch/ended` → 204: the launcher saying the launch's session has
// stopped (its minutes were up, the owner stopped it, or the launcher did), so it's dropped from the sessions.
export default defineEventHandler(event => {
    launchEnded(param(event, 'project'), param(event, 'launch'))
    setResponseStatus(event, 204)
    return null
})
