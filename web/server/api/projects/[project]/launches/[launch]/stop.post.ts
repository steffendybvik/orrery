// `POST /api/projects/:project/launches/:launch/stop` → the session: the owner stopping a session Orrery
// started. Its launcher kills it, and the session is gone once the launcher says so.
export default defineEventHandler(async event => {
    if (!(await actorOf(event)).owner) throw forbidden('Only the owner stops a session Orrery started; send Orrery-Actor: <owner>')
    return stopLaunch(param(event, 'project'), param(event, 'launch'))
})
