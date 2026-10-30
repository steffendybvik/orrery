// `POST /api/projects` {name, id?, key?, description?} → the new project, held by whoever made it.
export default defineEventHandler(async event => created(event, await useStore().createProject(await readBody(event), await actorOf(event), await personOf(event))))
