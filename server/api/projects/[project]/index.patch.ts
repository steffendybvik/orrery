// `PATCH /api/projects/:project` {name?, key?, description?, icon?, iconColor?, focusPrompt?, chunkPrompt?,
// instructions?, muted?} → the project. The prompt fields are the owner's.
export default defineEventHandler(async event => useStore().updateProject(param(event, 'project'), await readBody(event), await actorOf(event)))
