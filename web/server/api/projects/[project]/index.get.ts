// `GET /api/projects/:project` → the project with its board.
export default defineEventHandler(async event => useStore().project(param(event, 'project')))
