// `GET /api/projects/:project/releases` → its releases, newest first, each with how far its issues are.
export default defineEventHandler(async event => useStore().listReleases(param(event, 'project')))
