// `POST /api/projects/:project/launches` → 201 the launch `{id, project, after, minutes, tmux}`: the owner starting
// a session on the project by hand, through its launcher, within its limit. 409 when the project doesn't let
// Orrery start sessions, no launcher is running, or the limit is reached.
export default defineEventHandler(async event => {
    if (!(await actorOf(event)).owner) throw forbidden('Only the owner starts a session; send Orrery-Actor: <owner>')
    const launch = await startLaunch(param(event, 'project'))
    setResponseStatus(event, 201)
    return launch
})
