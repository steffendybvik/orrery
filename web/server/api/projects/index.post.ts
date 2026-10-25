// `POST /api/projects` {name, id?, key?, description?} → the new project.
export default defineEventHandler(async event => created(event, await useStore().createProject(await readBody(event), await actorOf(event))))
