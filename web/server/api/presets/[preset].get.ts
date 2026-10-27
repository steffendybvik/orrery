// `GET /api/presets/:preset` → the preset, the Orrery's or a project's.
export default defineEventHandler(async event => useStore().preset(Number(param(event, 'preset'))))
