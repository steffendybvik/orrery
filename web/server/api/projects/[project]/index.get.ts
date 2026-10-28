// `GET /api/projects/:project` → the project with its board, and `rev`, the revision the events stream's patches build on.
export default defineEventHandler(async event => withRev(await useStore().project(param(event, 'project'))))
