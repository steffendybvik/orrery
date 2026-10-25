// `GET /api/projects/:project/listeners` → {count}: the sessions listening for the project's signals.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().project(project)
    return {count: listening(project)}
})
