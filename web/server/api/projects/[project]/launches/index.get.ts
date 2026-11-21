// `GET /api/projects/:project/launches` → {launchers, minimum, folders, every, started, starting, total}: whether a
// launcher is there to start sessions for the project, the oldest version that does all this orrery asks of one, the
// folders they run in, whether one serves every project (its channel's `*`), how many it has running, how many are on
// their way, and how many its workspace has between its projects (ORR-1313).
import {launcherMinimum} from '#shared/version'

export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await projectIdOf(project)
    const people = await readFromApiOnly<unknown[]>('/api/people')
    return {...await launchState(project), minimum: launcherMinimum(people.length)}
})
