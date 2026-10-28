// `PATCH /api/projects/:project/releases/:release` {branch?, notes?, frozen_on?, shipped_on?} → the release.
export default defineEventHandler(async event => useStore().updateRelease(param(event, 'project'), param(event, 'release'), await readBody(event), await actorOf(event)))
