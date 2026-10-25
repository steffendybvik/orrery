// `PATCH /api/projects/:project/releases/:release` {branch?, notes?, shippedOn?} → the release.
export default defineEventHandler(async event => useStore().updateRelease(param(event, 'project'), param(event, 'release'), await readBody(event)))
