// `GET /api/projects/:project/releases/:release` → the release, with the issues set for it as `tasks`,
// and by project in `projects` (with the projects drawing on it, when it's their source).
export default defineEventHandler(async event => useStore().release(param(event, 'project'), param(event, 'release')))
