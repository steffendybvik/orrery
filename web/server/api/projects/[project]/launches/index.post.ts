// `POST /api/projects/:project/launches` {issue?, statuses?, release?} → 201 the launch `{id, project, after, minutes, tmux}`:
// the owner starting a session on the project by hand, through its launcher, within its limit; with `issue`, the
// session starts focused on it; with `statuses` (ids or kinds; `todo` and `started` when only `release` is sent)
// and `release`, it starts working through the project's issues in them, most urgent first. 409 when the project
// doesn't let Orrery start sessions, no launcher is running, or the limit is reached.
export default defineEventHandler(async event => {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner starts a session; send Orrery-Actor: <owner>')
    const {issue, statuses, release} = ((await readBody(event).catch(() => null)) ?? {}) as {issue?: unknown, statuses?: unknown, release?: unknown}
    if (issue !== undefined && issue !== null && typeof issue !== 'string') throw badRequest('Send {issue}: the id of an issue for the session to focus on, or nothing')
    if (statuses !== undefined && statuses !== null && (!Array.isArray(statuses) || statuses.some(s => typeof s !== 'string' || !s))) {
        throw badRequest('Send {statuses}: a list of status ids or kinds for the session to work through, e.g. ["todo", "started"]')
    }
    if (release !== undefined && release !== null && typeof release !== 'string') throw badRequest('Send {release}: the version of a release for the session to work through')
    if (issue && ((statuses as string[] | null)?.length || release)) throw badRequest('Send {issue} to focus on one issue, or {statuses, release} to work through many, not both')
    const launch = await startLaunch(param(event, 'project'), {issue: issue || undefined, statuses: (statuses as string[] | null) ?? undefined, release: release || undefined, actor})
    setResponseStatus(event, 201)
    return launch
})
