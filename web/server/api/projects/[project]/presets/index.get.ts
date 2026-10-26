// `GET /api/projects/:project/presets` → the presets a session on the project can have: the Orrery's
// (`project: null`), then its own.
export default defineEventHandler(async event => useStore().presets(param(event, 'project')))
