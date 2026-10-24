// `GET /api/projects/:project` → the project with its board.
export default defineEventHandler(event => useStore().project(param(event, 'project')))
