// `PATCH /api/presets/:preset` {name?, text?, icon?, color?} → the preset, the Orrery's or a project's.
export default defineEventHandler(async event => useStore().updatePreset(Number(param(event, 'preset')), await readBody(event)))
