// `POST /api/projects/:project/launches` {issue?} → 201 the launch `{id, project, after, minutes, tmux}`: the owner
// starting a session on the project by hand, through its launcher, within its limit; with `issue`, the session
// starts focused on it. 409 when the project doesn't let Orrery start sessions, no launcher is running, or the
// limit is reached.
export default defineEventHandler(async event => {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner starts a session; send Orrery-Actor: <owner>')
    const {issue} = ((await readBody(event).catch(() => null)) ?? {}) as {issue?: unknown}
    if (issue !== undefined && issue !== null && typeof issue !== 'string') throw badRequest('Send {issue}: the id of an issue for the session to focus on, or nothing')
    const launch = await startLaunch(param(event, 'project'), {issue: issue || undefined, actor})
    setResponseStatus(event, 201)
    return launch
})
