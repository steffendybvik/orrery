// `POST /api/projects/:project/launches/:launch/ended` → 204: the launcher saying the launch's session has
// stopped (its minutes were up, the owner stopped it, or the launcher did), so it's dropped from the sessions.
// Its stopping is the doing of the schedule run that started it, if one did, so it sets off no schedule (`asLaunch`).
// One orrery stopped as done, while the owner keeps a minimum running, is replaced (`keepMinimum`).
export default defineEventHandler(event => {
    const [project, launch] = [param(event, 'project'), param(event, 'launch')]
    asLaunch(launch, () => useEventLog().note({level: 'info', kind: 'session.stopped', project, message: 'A session orrery started has stopped', details: {launch}}))
    launchGone(launch)
    launchEnded(project, launch)
    keepMinimum().catch(error => console.error('[orrery] keeping the minimum of sessions running:', error))
    setResponseStatus(event, 204)
    return null
})
