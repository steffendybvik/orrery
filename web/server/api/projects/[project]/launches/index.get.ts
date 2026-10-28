// `GET /api/projects/:project/launches` → {launchers, folders, every, started, starting, total}: whether a launcher is
// there to start sessions for the project, the folders they run in, whether one serves every project (its channel's
// `*`), how many it has running, how many are on their way, and how many every project has.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().starts(project)
    return launchState(project)
})
