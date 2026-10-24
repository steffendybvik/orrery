// `GET /api/projects/:project/listeners` → {count}: the sessions listening for the project's signals.
export default defineEventHandler(event => {
    const project = param(event, 'project')
    useStore().project(project)
    return {count: listening(project)}
})
