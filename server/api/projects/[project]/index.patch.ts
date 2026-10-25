// `PATCH /api/projects/:project` {name?, key?, description?, icon?} → the project.
export default defineEventHandler(async event => useStore().updateProject(param(event, 'project'), await readBody(event)))
