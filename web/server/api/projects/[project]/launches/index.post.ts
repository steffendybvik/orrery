// `POST /api/projects/:project/launches` {issue?, statuses?, release?, presets?, instructions?, hears?} → 201 the launch
// `{id, project, after, minutes, tmux, context?, hears?}`: the owner starting a session on the project by hand, through its
// launcher, within its limit; with `issue`, the session starts focused on it; with `statuses` (ids or kinds; `todo`
// and `started` when only `release` is sent) and `release`, it starts working through the project's issues in them,
// most urgent first. `presets` (ids of the Orrery's or the project's) and `instructions` (the owner's own words) give
// it more context, which goes with every signal to it and back to it after a `/clear`. `hears` (project ids) is what
// the session hears: this project alone, or it and others served from the same repo, as one session; without it, what
// the repo's channel says. 409 when the project doesn't let Orrery start sessions, no launcher is running, the limit
// is reached, or a project in `hears` has no launcher in this project's folder.
export default defineEventHandler(async event => {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner starts a session; send Orrery-Actor: <owner>')
    const {issue, statuses, release, presets, instructions, hears} = ((await readBody(event).catch(() => null)) ?? {}) as {issue?: unknown, statuses?: unknown, release?: unknown, presets?: unknown, instructions?: unknown, hears?: unknown}
    if (issue !== undefined && issue !== null && typeof issue !== 'string') throw badRequest('Send {issue}: the id of an issue for the session to focus on, or nothing')
    if (statuses !== undefined && statuses !== null && (!Array.isArray(statuses) || statuses.some(s => typeof s !== 'string' || !s))) {
        throw badRequest('Send {statuses}: a list of status ids or kinds for the session to work through, e.g. ["todo", "started"]')
    }
    if (release !== undefined && release !== null && typeof release !== 'string') throw badRequest('Send {release}: the version of a release for the session to work through')
    if (issue && ((statuses as string[] | null)?.length || release)) throw badRequest('Send {issue} to focus on one issue, or {statuses, release} to work through many, not both')
    if (presets !== undefined && presets !== null && (!Array.isArray(presets) || presets.some(p => !Number.isInteger(p)))) {
        throw badRequest('Send {presets}: a list of preset ids (GET /api/projects/:project/presets), e.g. [3, 7]')
    }
    if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') throw badRequest('Send {instructions}: your own words for the session, as text')
    if (hears !== undefined && hears !== null && (!Array.isArray(hears) || !hears.length || hears.some(p => typeof p !== 'string' || !p))) {
        throw badRequest('Send {hears}: the ids of the projects the session hears, e.g. ["hub", "css"]')
    }
    const project = param(event, 'project')
    const context = await contextFor(project, (presets as number[] | null) ?? [], (instructions as string | null) ?? '')
    const launch = await startLaunch(project, {issue: issue || undefined, statuses: (statuses as string[] | null) ?? undefined, release: release || undefined, context, hears: (hears as string[] | null) ?? undefined, actor})
    setResponseStatus(event, 201)
    return launch
})
