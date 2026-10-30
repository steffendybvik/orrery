// `GET /api/projects/:project/members` → who's on the board: `[{person, name, role, created_at}]`, its holder first.
export default defineEventHandler(async event => useStore().members(param(event, 'project')))
