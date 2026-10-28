// `POST /api/projects/:project/sessions/:session/forget` → the session: the owner taking one with no channel open off
// the list. Nothing reaches its process; if it's still running, its next hook brings it back. 409 when its channel
// is open, as it's running: stop it instead.
export default defineEventHandler(async event => {
    if (!(await actorOf(event)).owner) throw forbidden('Only the owner forgets a session; send Orrery-Actor: <owner>')
    return forgetSession(param(event, 'project'), param(event, 'session'))
})
