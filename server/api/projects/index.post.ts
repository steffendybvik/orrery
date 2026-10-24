// `POST /api/projects` {name, id?, key?, description?} → the new project.
export default defineEventHandler(async event => created(event, useStore().createProject(await readBody(event), actorOf(event))))
