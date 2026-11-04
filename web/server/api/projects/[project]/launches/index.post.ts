// `POST /api/projects/:project/launches` {issue?, statuses?, release?, presets?, instructions?, hears?, model?, effort?} → 201 the launch
// `{id, project, after, minutes, tmux, context?, hears?, model?, effort?}`: the owner starting a session on the project by hand, through its
// launcher, within its limit; with `issue`, the session starts focused on it; with `statuses` (ids or kinds; `todo`
// and `started` when only `release` is sent) and `release`, it starts working through the project's issues in them,
// most urgent first. `presets` (ids of the orrery's or the project's) and `instructions` (the owner's own words) give
// it more context, which goes with every signal to it and back to it after a `/clear`. `hears` (project ids) is what
// the session hears: this project alone, or it and others served from the same repo, as one session; without it, what
// the repo's channel says. `model` (`best`, `opus`, `sonnet`, `haiku`… or a full id) and `effort` (`low`…`max`) start it
// on them, as `claude --model … --effort …`; without, on Claude Code's default there. 409 when the project doesn't let orrery start sessions, no launcher is running, the limit
// is reached, or a project in `hears` has no launcher in this project's folder.
import {countOwnUse} from '../../../../utils/usage'

export default defineEventHandler(async event => {
    countOwnUse(event, 'start-session')
    const actor = await authorize(event, 'sessions.start')
    const {issue, statuses, release, presets, instructions, hears, model, effort} = startInput((await readBody(event).catch(() => null)) ?? {})
    const project = param(event, 'project')
    const context = await contextFor(project, presets, instructions)
    const launch = await startLaunch(project, {issue, statuses, release, context, hears, model, effort, actor})
        .catch((error: {statusCode?: number, message?: string}) => {
            if (error.statusCode === 409) useEventLog().note({level: 'warn', kind: 'session.refused', project, message: error.message ?? "Couldn't start a session"})
            throw error
        })
    setResponseStatus(event, 201)
    return launch
})
