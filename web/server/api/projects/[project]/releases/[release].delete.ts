// `DELETE /api/projects/:project/releases/:release` → 204. Its issues stay, set for no release.
export default defineEventHandler(async event => {
    await useStore().deleteRelease(param(event, 'project'), param(event, 'release'), await actorOf(event))
    return deleted(event)
})
