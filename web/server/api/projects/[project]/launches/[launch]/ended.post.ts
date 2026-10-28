// `POST /api/projects/:project/launches/:launch/ended` → 204: the launcher saying the launch's session has
// stopped (its minutes were up, the owner stopped it, or the launcher did), so it's dropped from the sessions.
export default defineEventHandler(event => {
    launchGone(param(event, 'launch'))
    launchEnded(param(event, 'project'), param(event, 'launch'))
    useEventLog().note({level: 'info', kind: 'session.stopped', project: param(event, 'project'), message: 'A session orrery started has stopped', details: {launch: param(event, 'launch')}})
    setResponseStatus(event, 204)
    return null
})
