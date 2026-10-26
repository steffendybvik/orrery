// `PATCH /api/projects/:project` {name?, key?, description?, icon?, icon_color?, focus_prompt?, chunk_prompt?,
// instructions?, muted?, starts?, repo?, releases_from?} → the project. The prompt fields and `starts` are the owner's.
export default defineEventHandler(async event => useStore().updateProject(param(event, 'project'), await readBody(event), await actorOf(event)))
