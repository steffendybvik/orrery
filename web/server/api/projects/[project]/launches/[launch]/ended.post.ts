// `POST /api/projects/:project/launches/:launch/ended` → 204: the launcher saying the launch's session has
// stopped (its minutes were up, the owner stopped it, or the launcher did), so it's dropped from the sessions.
// Its stopping is the doing of the schedule run that started it, if one did, so it sets off no schedule (`asLaunch`).
export default defineEventHandler(event => {
    const [project, launch] = [param(event, 'project'), param(event, 'launch')]
    asLaunch(launch, () => useEventLog().note({level: 'info', kind: 'session.stopped', project, message: 'A session Orrery started has stopped', details: {launch}}))
    launchGone(launch)
    launchEnded(project, launch)
    setResponseStatus(event, 204)
    return null
})
