// `POST /api/projects/:project/releases` {version, branch?, notes?, frozen_on?, shipped_on?} → the new release.
export default defineEventHandler(async event => created(event, await useStore().createRelease(param(event, 'project'), await readBody(event), await actorOf(event))))
