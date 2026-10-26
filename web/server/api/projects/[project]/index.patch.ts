// `PATCH /api/projects/:project` {name?, key?, description?, icon?, iconColor?, focusPrompt?, chunkPrompt?,
// instructions?, muted?, starts?, repo?, releasesFrom?} → the project. The prompt fields and `starts` are the owner's.
export default defineEventHandler(async event => useStore().updateProject(param(event, 'project'), await readBody(event), await actorOf(event)))
