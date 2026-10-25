// `GET /api/projects/:project/releases/:release` → the release, with the issues set for it as `tasks`.
export default defineEventHandler(async event => useStore().release(param(event, 'project'), param(event, 'release')))
