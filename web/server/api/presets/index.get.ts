// `GET /api/presets` → the Orrery's presets, for sessions on any project: `{id, project: null, name, text}`.
// A project's own are at `/api/projects/:project/presets`.
export default defineEventHandler(async () => useStore().presets())
