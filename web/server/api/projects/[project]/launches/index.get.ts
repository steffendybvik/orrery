// `GET /api/projects/:project/launches` → {launchers, started, starting}: whether a launcher is there to start
// sessions for the project, how many it has running, and how many are on their way.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().project(project)
    return launchState(project)
})
