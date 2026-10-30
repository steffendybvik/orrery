// `GET /api/projects/:project/launches` → {launchers, minimum, folders, every, started, starting, total}: whether a
// launcher is there to start sessions for the project, the oldest version that does all this orrery asks of one, the
// folders they run in, whether one serves every project (its channel's `*`), how many it has running, how many are on
// their way, and how many every project has.
import {launcherMinimum} from '#shared/version'

export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const store = useStore()
    await store.starts(project)
    return {...launchState(project), minimum: launcherMinimum((await store.people()).length)}
})
